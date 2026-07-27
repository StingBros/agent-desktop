//! Control socket for the `agent-orchestration-runtime` capability.
//!
//! The pane registry (which agents/panes exist) is FRONTEND-owned; PTY I/O and
//! sockets are RUST-owned. So when an orchestrator's bundled MCP toolkit wants to
//! spawn / message / read an agent pane, the call must round-trip:
//!
//!   MCP adapter → Rust control socket → (Tauri `orchestration://request` event)
//!     → frontend executor → (`orchestration_reply` Tauri command) → Rust
//!     → back over the socket connection.
//!
//! This module owns the RUST transport in the middle: a Unix-domain socket that
//! accepts one JSON request per connection, assigns it a unique request id, emits
//! the request to the frontend, awaits the matching reply (with a per-request
//! timeout), and writes the JSON response back over the same connection.
//!
//! Concurrency mirrors [`crate::events`]: std threads + `Mutex`, no async runtime.
//! Each accepted connection is served on its own thread; the reply for an in-flight
//! request arrives on a `std::sync::mpsc` channel that the serving thread blocks on
//! (with a timeout). A small per-target serialization queue ensures two ops aimed
//! at the SAME target — an agent pane (`paneId`), or a Task (`taskId`) for the
//! worker back-channel ops — do not interleave, while ops with no target, or aimed
//! at different targets, proceed concurrently.
//!
//! Socket-path convention matches the events socket (a basename under the app-data
//! dir; see `lib.rs`). The path is exported to a launched coordinator session via
//! the [`CONTROL_SOCKET_ENV`] environment variable so the bundled adapter can find
//! it (the events socket uses `AGENT_DESKTOP_SOCKET_PATH`; this is its sibling).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};

use crate::ipc::ListenerExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The Tauri event name each inbound control request is emitted on. The frontend
/// orchestration executor listens on exactly this name.
pub const REQUEST_EVENT: &str = "orchestration://request";

/// Environment variable carrying the absolute control-socket path into a launched
/// coordinator session (so the bundled MCP adapter can connect). Sibling of the
/// event hook's `AGENT_DESKTOP_SOCKET_PATH`.
pub const CONTROL_SOCKET_ENV: &str = "AGENT_DESKTOP_CONTROL_SOCKET";

/// How long the serving thread waits for the frontend's `orchestration_reply`
/// before giving up and writing a `{ id, error: "timeout" }` response. Generous
/// because an op may launch a pane / drive a PTY on the frontend.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// One inbound control request as parsed off the socket: an `op` (toolkit op name)
/// and opaque `args` forwarded verbatim to the frontend. The request `id` is
/// assigned by Rust, not carried in the inbound payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlRequest {
    /// The toolkit op (e.g. `spawn_agent`, `message_agent`, `list_agents`).
    pub op: String,
    /// Opaque op arguments, forwarded to the frontend verbatim.
    #[serde(default)]
    pub args: Value,
}

/// Parse one inbound socket line into a [`ControlRequest`]. Returns `None` for a
/// blank line or anything missing a non-empty `op`, so a malformed request is
/// rejected rather than dispatched.
fn parse_request(raw: &str) -> Option<ControlRequest> {
    let line = raw.trim();
    if line.is_empty() {
        return None;
    }
    let req: ControlRequest = serde_json::from_str(line).ok()?;
    if req.op.is_empty() {
        return None;
    }
    Some(req)
}

/// The outcome the frontend returns for a request: a `result` JSON value or an
/// `error` string. Exactly one is meaningful; `error` wins if both are somehow set.
#[derive(Debug, Clone, PartialEq)]
pub enum ReplyOutcome {
    Result(Value),
    Error(String),
}

impl ReplyOutcome {
    /// Build the JSON response object written back over the socket for `id`.
    fn to_response(&self, id: u64) -> Value {
        match self {
            ReplyOutcome::Result(v) => json!({ "id": id, "result": v }),
            ReplyOutcome::Error(e) => json!({ "id": id, "error": e }),
        }
    }
}

/// The id → reply-channel registry. Each in-flight request registers a oneshot
/// (`std::sync::mpsc` used once) sender keyed by its id; the serving thread holds
/// the receiver and blocks on it (with a timeout). `orchestration_reply` looks up
/// the sender by id and delivers the outcome, waking exactly that one request.
///
/// PURE of any socket / Tauri dependency so the routing can be unit-tested
/// directly (see tests): register two ids, complete them out of order, and assert
/// each receiver gets only its own outcome.
#[derive(Default)]
pub struct PendingRegistry {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<ReplyOutcome>>>,
}

impl PendingRegistry {
    pub fn new() -> Self {
        Self {
            // Start at 1 so 0 is never a valid request id.
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Register a fresh in-flight request: returns its unique `id` and the receiver
    /// the serving thread blocks on. The matching sender is stored under `id` until
    /// [`complete`](Self::complete) delivers (or [`forget`](Self::forget) drops it).
    pub fn register(&self) -> (u64, Receiver<ReplyOutcome>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(id, tx);
        }
        (id, rx)
    }

    /// Deliver `outcome` to the request registered under `id`, removing it from the
    /// table. Returns `true` if a waiting request was found (the reply was routed),
    /// `false` for an unknown / already-completed / timed-out id (a late reply).
    pub fn complete(&self, id: u64, outcome: ReplyOutcome) -> bool {
        let tx = match self.pending.lock() {
            Ok(mut map) => map.remove(&id),
            Err(_) => None,
        };
        match tx {
            // Send can only fail if the serving thread already dropped its receiver
            // (timed out); treat that as "not delivered" too.
            Some(tx) => tx.send(outcome).is_ok(),
            None => false,
        }
    }

    /// Drop the pending entry for `id` without delivering (the serving thread timed
    /// out). Prevents a later reply from being routed to a gone request and frees
    /// the slot.
    pub fn forget(&self, id: u64) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&id);
        }
    }

    /// Count of in-flight requests (test/observability helper).
    #[cfg(test)]
    pub fn in_flight(&self) -> usize {
        self.pending.lock().map(|m| m.len()).unwrap_or(0)
    }
}

/// Per-target serialization queue. Ops targeting ONE target — an agent pane
/// (`paneId`), or a Task (`taskId`) for the worker back-channel ops — must not
/// interleave: a second op for the same target waits for the first to finish. Ops
/// with no target are not serialized. See [`target_of`](Self::target_of) for how the
/// key is chosen.
///
/// Implemented as a set of "busy" targets guarded by a `Condvar`: acquiring a
/// target blocks while it is busy, then marks it busy and hands back a guard whose
/// `Drop` clears it and notifies waiters. FIFO fairness is not guaranteed by the
/// condvar, but the contract — same target sequential, different targets concurrent
/// — holds. PURE of socket / Tauri so ordering can be unit-tested directly.
#[derive(Default)]
pub struct TargetQueues {
    inner: Arc<TargetQueuesInner>,
}

#[derive(Default)]
struct TargetQueuesInner {
    busy: Mutex<std::collections::HashSet<String>>,
    cv: Condvar,
}

/// Held for the duration of a target-serialized op; its `Drop` releases the target.
#[must_use = "the target stays locked until this guard is dropped"]
pub struct TargetGuard {
    inner: Arc<TargetQueuesInner>,
    target: String,
}

impl Drop for TargetGuard {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.inner.busy.lock() {
            busy.remove(&self.target);
        }
        // Wake every waiter; the one(s) for this target will re-check and proceed.
        self.inner.cv.notify_all();
    }
}

impl TargetQueues {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(TargetQueuesInner::default()),
        }
    }

    /// Determine the serialization target for a request. A back-channel op
    /// (`report_progress` / `report_done` / `report_blocked` / `ask_coordinator`)
    /// carries a `taskId`, and concurrent reports to the SAME Task must not
    /// interleave — so `taskId`, when present, is the serialization key (D8). Every
    /// other op (`message_agent` / `read_agent` / etc.) keys on `paneId`, the agent
    /// it acts on. Ops with neither (e.g. `list_agents`, `spawn_agent`) return `None`
    /// and are not serialized against any target.
    ///
    /// `taskId` wins over `paneId` when both are present (a back-channel op stamps
    /// both), so two reports for one Task serialize even though they share a pane,
    /// while reports for different Tasks proceed concurrently.
    pub fn target_of(args: &Value) -> Option<String> {
        let field = |key: &str| {
            args.get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
        };
        field("taskId")
            .or_else(|| field("paneId"))
            .map(|s| s.to_string())
    }

    /// Acquire exclusive access to `target`, blocking while another op holds it.
    /// Returns a guard that releases the target on drop. Different targets never
    /// block each other.
    pub fn acquire(&self, target: &str) -> TargetGuard {
        let mut busy = self.inner.busy.lock().expect("target queue lock poisoned");
        while busy.contains(target) {
            busy = self.inner.cv.wait(busy).expect("target queue cv poisoned");
        }
        busy.insert(target.to_string());
        TargetGuard {
            inner: self.inner.clone(),
            target: target.to_string(),
        }
    }

    /// Run `f` while holding `target` serialized when present; ops with no target
    /// run without serialization. The guard (if any) is held for the whole call.
    pub fn run_serialized<T>(&self, target: Option<&str>, f: impl FnOnce() -> T) -> T {
        let _guard = target.map(|t| self.acquire(t));
        f()
    }
}

/// Owns the control-socket listener thread + the shared pending/queue state.
/// Dropping it removes the socket file; the app holds exactly one in managed state.
pub struct ControlServer {
    address: String,
    pending: Arc<PendingRegistry>,
}

impl ControlServer {
    /// The pending registry (so the `orchestration_reply` command can route replies).
    pub fn pending(&self) -> &Arc<PendingRegistry> {
        &self.pending
    }

    /// The address the bundled MCP adapter connects to — the exact string exported
    /// as [`CONTROL_SOCKET_ENV`].
    pub fn address(&self) -> &str {
        &self.address
    }
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        crate::ipc::cleanup_address(&self.address);
    }
}

/// Bind the control socket at `socket_path` (removing any STALE file first so a
/// crash/restart always binds cleanly) and spawn the accept thread. Each accepted
/// connection's one JSON-line request is parsed, assigned a unique id, emitted via
/// `on_request` (which in production emits the `orchestration://request` Tauri
/// event), and awaited (with [`REQUEST_TIMEOUT`]); the JSON response is written
/// back over the same connection. Per-target ops are serialized.
///
/// `address` MUST come from [`crate::ipc::control_address`] — the same call that
/// produces the value exported to a coordinator as `AGENT_DESKTOP_CONTROL_SOCKET`,
/// so the bound socket and the advertised one cannot disagree.
///
/// `on_request` runs on a per-connection serving thread and must be `Send + Sync`.
/// Returns the [`ControlServer`] the caller keeps alive (and whose
/// [`pending`](ControlServer::pending) the reply command routes through).
pub fn start_control_server<F>(address: &str, on_request: F) -> Result<ControlServer, String>
where
    F: Fn(u64, &ControlRequest) + Send + Sync + 'static,
{
    start_control_server_with_timeout(address, REQUEST_TIMEOUT, on_request)
}

/// [`start_control_server`] with an explicit per-request `timeout`. Production uses
/// [`REQUEST_TIMEOUT`]; tests pass a short timeout to exercise the timeout path
/// end-to-end without a 30s wait.
fn start_control_server_with_timeout<F>(
    address: &str,
    timeout: Duration,
    on_request: F,
) -> Result<ControlServer, String>
where
    F: Fn(u64, &ControlRequest) + Send + Sync + 'static,
{
    // A stale entry from a prior run never blocks the bind: unlinked on Unix,
    // impossible on Windows (a dead process leaves no pipe). See `crate::ipc`.
    let listener =
        crate::ipc::bind_listener(address).map_err(|e| format!("bind {address:?}: {e}"))?;
    let address = address.to_string();

    let pending = Arc::new(PendingRegistry::new());
    let queues = Arc::new(TargetQueues::new());
    let on_request = Arc::new(on_request);

    let accept_pending = pending.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else {
                continue; // accept error: skip this connection, keep serving.
            };
            let pending = accept_pending.clone();
            let queues = queues.clone();
            let on_request = on_request.clone();
            // Serve each connection on its own thread so a slow/awaiting request
            // never blocks accepting the next one.
            std::thread::spawn(move || {
                serve_connection(stream, &pending, &queues, on_request.as_ref(), timeout);
            });
        }
    });

    Ok(ControlServer { address, pending })
}

/// Serve one accepted connection: read the request line, register it, dispatch it
/// (serialized per target), await the reply (or time out), and write the response.
fn serve_connection<F>(
    stream: crate::ipc::Stream,
    pending: &Arc<PendingRegistry>,
    queues: &Arc<TargetQueues>,
    on_request: &F,
    timeout: Duration,
) where
    F: Fn(u64, &ControlRequest) + Send + Sync,
{
    // `Read`/`Write` are implemented for `&Stream`, so the read and write halves
    // are two borrows of the one stream — no `try_clone` (which named pipes do
    // not offer) and no fallible duplication step.
    let mut writer = &stream;
    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let Some(req) = parse_request(&line) else {
        return; // malformed request: drop the connection.
    };

    let target = TargetQueues::target_of(&req.args);
    // Serialize the WHOLE round-trip per target: register → emit → await reply, so a
    // second op for the same target waits for the first to fully complete.
    let response = queues.run_serialized(target.as_deref(), || {
        let (id, rx) = pending.register();
        on_request(id, &req);
        match rx.recv_timeout(timeout) {
            Ok(outcome) => outcome.to_response(id),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                // Drop the pending slot so a late reply isn't misrouted, and return
                // a structured timeout error rather than hanging the orchestrator.
                pending.forget(id);
                ReplyOutcome::Error("timeout".to_string()).to_response(id)
            }
        }
    });

    if let Ok(body) = serde_json::to_string(&response) {
        let _ = writeln!(writer, "{body}");
        let _ = writer.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicBool;
    use std::time::{Instant, SystemTime};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            // Keep this SHORT: a Unix-domain socket path under it must fit
            // SUN_LEN (~104 bytes on macOS), and the system temp dir is already long.
            let dir = std::env::temp_dir().join(format!("ado-{tag}-{nanos}"));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // ---- parse_request ----

    #[test]
    fn parses_a_well_formed_request() {
        let req = parse_request(r#"{"op":"message_agent","args":{"paneId":"p1","text":"hi"}}"#)
            .expect("parsed");
        assert_eq!(req.op, "message_agent");
        assert_eq!(req.args["paneId"], json!("p1"));
    }

    #[test]
    fn rejects_blank_and_opless_requests() {
        assert!(parse_request("   ").is_none());
        assert!(parse_request("{not json").is_none());
        assert!(parse_request(r#"{"args":{}}"#).is_none()); // no op
        assert!(parse_request(r#"{"op":""}"#).is_none()); // empty op
    }

    #[test]
    fn args_default_to_null_when_absent() {
        let req = parse_request(r#"{"op":"list_agents"}"#).expect("parsed");
        assert_eq!(req.op, "list_agents");
        assert!(req.args.is_null());
        // No paneId target for an op without args.
        assert_eq!(TargetQueues::target_of(&req.args), None);
    }

    // ---- PendingRegistry routing (3.3: concurrent distinct ids do not cross) ----

    #[test]
    fn register_yields_unique_increasing_ids() {
        let reg = PendingRegistry::new();
        let (a, _ra) = reg.register();
        let (b, _rb) = reg.register();
        let (c, _rc) = reg.register();
        assert!(a >= 1 && b > a && c > b, "ids unique and increasing: {a},{b},{c}");
        assert_eq!(reg.in_flight(), 3);
    }

    #[test]
    fn complete_routes_each_reply_to_its_own_request() {
        let reg = PendingRegistry::new();
        let (id1, rx1) = reg.register();
        let (id2, rx2) = reg.register();
        assert_ne!(id1, id2);

        // Complete out of order; each receiver must get ONLY its own outcome.
        assert!(reg.complete(id2, ReplyOutcome::Result(json!({"who": 2}))));
        assert!(reg.complete(id1, ReplyOutcome::Error("boom".into())));

        let got1 = rx1.recv_timeout(Duration::from_secs(1)).unwrap();
        let got2 = rx2.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(got1, ReplyOutcome::Error("boom".into()));
        assert_eq!(got2, ReplyOutcome::Result(json!({"who": 2})));
        // Both slots freed.
        assert_eq!(reg.in_flight(), 0);
    }

    #[test]
    fn complete_unknown_id_is_a_noop() {
        let reg = PendingRegistry::new();
        assert!(!reg.complete(999, ReplyOutcome::Result(json!(null))));
    }

    #[test]
    fn forget_drops_the_slot_so_a_late_reply_is_not_routed() {
        let reg = PendingRegistry::new();
        let (id, rx) = reg.register();
        reg.forget(id);
        assert_eq!(reg.in_flight(), 0);
        // A reply after forget finds no waiter.
        assert!(!reg.complete(id, ReplyOutcome::Result(json!(1))));
        // The receiver sees the channel disconnected (sender dropped on forget).
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn outcome_serializes_to_id_keyed_response() {
        assert_eq!(
            ReplyOutcome::Result(json!({"paneId": "p9"})).to_response(7),
            json!({"id": 7, "result": {"paneId": "p9"}})
        );
        assert_eq!(
            ReplyOutcome::Error("nope".into()).to_response(8),
            json!({"id": 8, "error": "nope"})
        );
    }

    // ---- TargetQueues serialization (3.4) ----

    #[test]
    fn target_of_keys_on_pane_id_for_existing_ops() {
        assert_eq!(
            TargetQueues::target_of(&json!({"paneId": "p1", "text": "x"})),
            Some("p1".to_string())
        );
        assert_eq!(TargetQueues::target_of(&json!({"prompt": "go"})), None);
        assert_eq!(TargetQueues::target_of(&json!({"paneId": ""})), None);
        assert_eq!(TargetQueues::target_of(&Value::Null), None);
    }

    /// A back-channel op carries `taskId`, which is the serialization key (D8): when
    /// present it WINS over `paneId` (a report stamps both), so reports for one Task
    /// serialize while reports for different Tasks stay independent. Falls back to
    /// `paneId` when `taskId` is absent/blank.
    #[test]
    fn target_of_prefers_task_id_over_pane_id() {
        // Both present: taskId wins (per-Task serialization).
        assert_eq!(
            TargetQueues::target_of(&json!({"taskId": "T3", "paneId": "p1", "note": "x"})),
            Some("T3".to_string())
        );
        // taskId only (e.g. a report whose pane isn't stamped): keyed on taskId.
        assert_eq!(
            TargetQueues::target_of(&json!({"taskId": "T7", "result": "done"})),
            Some("T7".to_string())
        );
        // Blank taskId falls back to paneId (never keys on an empty string).
        assert_eq!(
            TargetQueues::target_of(&json!({"taskId": "", "paneId": "p2"})),
            Some("p2".to_string())
        );
        // Neither present: not serialized.
        assert_eq!(
            TargetQueues::target_of(&json!({"taskId": "", "paneId": ""})),
            None
        );
    }

    /// Two ops to the SAME target run sequentially: the second cannot start its
    /// critical section until the first's guard drops.
    #[test]
    fn same_target_ops_run_sequentially() {
        let queues = Arc::new(TargetQueues::new());
        let log = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        // Hold the first op long enough that the second would interleave if it could.
        let q1 = queues.clone();
        let l1 = log.clone();
        let started = Arc::new(AtomicBool::new(false));
        let s1 = started.clone();
        let t1 = std::thread::spawn(move || {
            q1.run_serialized(Some("pX"), || {
                l1.lock().unwrap().push("1-start");
                s1.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(150));
                l1.lock().unwrap().push("1-end");
            });
        });
        // Ensure thread 1 has entered its critical section before thread 2 attempts.
        while !started.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let q2 = queues.clone();
        let l2 = log.clone();
        let t2 = std::thread::spawn(move || {
            q2.run_serialized(Some("pX"), || {
                l2.lock().unwrap().push("2-start");
                l2.lock().unwrap().push("2-end");
            });
        });
        t1.join().unwrap();
        t2.join().unwrap();
        // The first op must fully complete before the second starts.
        assert_eq!(
            *log.lock().unwrap(),
            vec!["1-start", "1-end", "2-start", "2-end"]
        );
    }

    /// Ops to DIFFERENT targets run concurrently: the second enters its critical
    /// section while the first is still holding its own target.
    #[test]
    fn different_targets_run_concurrently() {
        let queues = Arc::new(TargetQueues::new());
        let a_in = Arc::new(AtomicBool::new(false));
        let b_in = Arc::new(AtomicBool::new(false));

        let qa = queues.clone();
        let a_in_c = a_in.clone();
        let b_in_probe = b_in.clone();
        let ta = std::thread::spawn(move || {
            qa.run_serialized(Some("A"), || {
                a_in_c.store(true, Ordering::SeqCst);
                // While we hold A, B must be able to enter concurrently. Wait (bounded)
                // for B to signal it's inside — proves no cross-target blocking.
                let start = Instant::now();
                while !b_in_probe.load(Ordering::SeqCst) {
                    assert!(
                        start.elapsed() < Duration::from_secs(2),
                        "different target B never ran concurrently"
                    );
                    std::thread::sleep(Duration::from_millis(1));
                }
            });
        });
        let qb = queues.clone();
        let b_in_c = b_in.clone();
        let tb = std::thread::spawn(move || {
            qb.run_serialized(Some("B"), || {
                b_in_c.store(true, Ordering::SeqCst);
            });
        });
        ta.join().unwrap();
        tb.join().unwrap();
        assert!(a_in.load(Ordering::SeqCst) && b_in.load(Ordering::SeqCst));
    }

    /// Untargeted ops are never serialized against each other (both run at once even
    /// though neither completes until the other has entered).
    #[test]
    fn untargeted_ops_are_not_serialized() {
        let queues = Arc::new(TargetQueues::new());
        let one_in = Arc::new(AtomicBool::new(false));
        let two_in = Arc::new(AtomicBool::new(false));

        let q1 = queues.clone();
        let one_in_c = one_in.clone();
        let two_probe = two_in.clone();
        let t1 = std::thread::spawn(move || {
            q1.run_serialized(None, || {
                one_in_c.store(true, Ordering::SeqCst);
                let start = Instant::now();
                while !two_probe.load(Ordering::SeqCst) {
                    assert!(start.elapsed() < Duration::from_secs(2), "untargeted op 2 blocked");
                    std::thread::sleep(Duration::from_millis(1));
                }
            });
        });
        let q2 = queues.clone();
        let two_in_c = two_in.clone();
        let t2 = std::thread::spawn(move || {
            q2.run_serialized(None, || {
                two_in_c.store(true, Ordering::SeqCst);
            });
        });
        t1.join().unwrap();
        t2.join().unwrap();
        assert!(one_in.load(Ordering::SeqCst) && two_in.load(Ordering::SeqCst));
    }

    /// D8 end-to-end on the KEY DERIVATION: two back-channel ops for the SAME Task
    /// (`taskId` derived via `target_of`, as `serve_connection` does) run sequentially
    /// even though they carry different `paneId`s — the Task is the serialization key.
    #[test]
    fn same_task_reports_run_sequentially() {
        let queues = Arc::new(TargetQueues::new());
        let log = Arc::new(Mutex::new(Vec::<&'static str>::new()));

        // Two reports for Task T1, from different panes — must still serialize.
        let a1 = json!({"taskId": "T1", "paneId": "pA", "note": "step 1"});
        let a2 = json!({"taskId": "T1", "paneId": "pB", "note": "step 2"});
        let k1 = TargetQueues::target_of(&a1);
        let k2 = TargetQueues::target_of(&a2);
        assert_eq!(k1, Some("T1".to_string()));
        assert_eq!(k2, Some("T1".to_string()));

        let q1 = queues.clone();
        let l1 = log.clone();
        let started = Arc::new(AtomicBool::new(false));
        let s1 = started.clone();
        let t1 = std::thread::spawn(move || {
            q1.run_serialized(k1.as_deref(), || {
                l1.lock().unwrap().push("1-start");
                s1.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(150));
                l1.lock().unwrap().push("1-end");
            });
        });
        while !started.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let q2 = queues.clone();
        let l2 = log.clone();
        let t2 = std::thread::spawn(move || {
            q2.run_serialized(k2.as_deref(), || {
                l2.lock().unwrap().push("2-start");
                l2.lock().unwrap().push("2-end");
            });
        });
        t1.join().unwrap();
        t2.join().unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            vec!["1-start", "1-end", "2-start", "2-end"],
            "reports for the same Task must not interleave"
        );
    }

    /// D8: two back-channel ops for DIFFERENT Tasks run concurrently — the second
    /// enters its critical section while the first still holds its own Task.
    #[test]
    fn different_task_reports_run_concurrently() {
        let queues = Arc::new(TargetQueues::new());
        let a_in = Arc::new(AtomicBool::new(false));
        let b_in = Arc::new(AtomicBool::new(false));

        let ka = TargetQueues::target_of(&json!({"taskId": "Ta", "paneId": "p1"}));
        let kb = TargetQueues::target_of(&json!({"taskId": "Tb", "paneId": "p1"}));
        // Same pane, different Tasks: they must NOT block each other (keyed on Task).
        assert_eq!(ka, Some("Ta".to_string()));
        assert_eq!(kb, Some("Tb".to_string()));

        let qa = queues.clone();
        let a_in_c = a_in.clone();
        let b_in_probe = b_in.clone();
        let ta = std::thread::spawn(move || {
            qa.run_serialized(ka.as_deref(), || {
                a_in_c.store(true, Ordering::SeqCst);
                let start = Instant::now();
                while !b_in_probe.load(Ordering::SeqCst) {
                    assert!(
                        start.elapsed() < Duration::from_secs(2),
                        "different Task Tb never ran concurrently"
                    );
                    std::thread::sleep(Duration::from_millis(1));
                }
            });
        });
        let qb = queues.clone();
        let b_in_c = b_in.clone();
        let tb = std::thread::spawn(move || {
            qb.run_serialized(kb.as_deref(), || {
                b_in_c.store(true, Ordering::SeqCst);
            });
        });
        ta.join().unwrap();
        tb.join().unwrap();
        assert!(a_in.load(Ordering::SeqCst) && b_in.load(Ordering::SeqCst));
    }

    // ---- Full socket round-trip ----

    /// Helper: connect, send one request line, read the one response line back.
    /// Platform-agnostic — reaches a Unix socket or a Windows named pipe.
    fn round_trip(address: &str, request_line: &str) -> Value {
        let mut s = crate::ipc::connect(address).unwrap();
        s.write_all(request_line.as_bytes()).unwrap();
        s.write_all(b"\n").unwrap();
        s.flush().unwrap();
        let mut resp = String::new();
        s.read_to_string(&mut resp).unwrap();
        serde_json::from_str(resp.trim()).unwrap()
    }

    /// A request emitted to the frontend is answered via the pending registry and
    /// the result is written back over the socket, keyed by the assigned id.
    #[test]
    fn socket_request_round_trips_a_reply() {
        let tmp = TempDir::new("roundtrip");
        let socket = tmp.path().join("c.sock");

        // The "frontend": when a request is emitted, complete it on a side thread
        // with a result echoing the op.
        let server = {
            // Need the server's pending registry inside on_request, but it is created
            // by start_control_server. Capture it via a shared cell the closure reads.
            let captured: Arc<Mutex<Option<Arc<PendingRegistry>>>> = Arc::new(Mutex::new(None));
            let cap = captured.clone();
            let srv = start_control_server(&crate::ipc::socket_address(&socket), move |id, req| {
                let pending = cap.lock().unwrap().clone().expect("pending wired");
                let op = req.op.clone();
                std::thread::spawn(move || {
                    pending.complete(id, ReplyOutcome::Result(json!({ "echo": op })));
                });
            })
            .unwrap();
            *captured.lock().unwrap() = Some(srv.pending().clone());
            srv
        };

        let resp = round_trip(server.address(), r#"{"op":"list_agents","args":{}}"#);
        assert_eq!(resp["result"], json!({"echo": "list_agents"}));
        assert!(resp["id"].as_u64().unwrap() >= 1, "id assigned");
        drop(server);
    }

    /// The transport is op-AGNOSTIC for delivery: a back-channel op it has never seen
    /// hard-coded (`report_done`, carrying `{taskId, projectId, paneId, ...}`) is
    /// parsed, assigned an id, emitted, and its reply is written back id-matched —
    /// exactly like the existing ops. Confirms 4.1/4.2 without any op allow-list.
    #[test]
    fn back_channel_op_round_trips_a_reply() {
        let tmp = TempDir::new("backchannel");
        let socket = tmp.path().join("c.sock");

        let captured: Arc<Mutex<Option<Arc<PendingRegistry>>>> = Arc::new(Mutex::new(None));
        let cap = captured.clone();
        // Echo the op AND the delivered taskId, proving args are forwarded verbatim.
        let server = start_control_server(&crate::ipc::socket_address(&socket), move |id, req| {
            let pending = cap.lock().unwrap().clone().expect("pending wired");
            let op = req.op.clone();
            let task = req.args["taskId"].as_str().unwrap_or("").to_string();
            std::thread::spawn(move || {
                pending.complete(id, ReplyOutcome::Result(json!({ "op": op, "taskId": task })));
            });
        })
        .unwrap();
        *captured.lock().unwrap() = Some(server.pending().clone());

        let resp = round_trip(
            server.address(),
            r#"{"op":"report_done","args":{"taskId":"T9","projectId":"proj","paneId":"p1","result":"ok"}}"#,
        );
        assert_eq!(resp["result"], json!({"op": "report_done", "taskId": "T9"}));
        assert!(resp["id"].as_u64().unwrap() >= 1, "id assigned to the reply");
        drop(server);
    }

    /// A request the frontend never answers within the timeout gets a structured
    /// `{ error: "timeout" }` response over the socket, and its pending slot is freed
    /// (so a late reply can't be misrouted). Driven end-to-end with a short timeout.
    #[test]
    fn unanswered_request_times_out_with_error() {
        let tmp = TempDir::new("timeout");
        let socket = tmp.path().join("c.sock");
        let captured: Arc<Mutex<Option<Arc<PendingRegistry>>>> = Arc::new(Mutex::new(None));
        let cap = captured.clone();
        // The frontend deliberately never replies.
        let server =
            start_control_server_with_timeout(
            &crate::ipc::socket_address(&socket), Duration::from_millis(80), move |_id, _req| {
                let _ = cap.lock().unwrap().clone();
            })
            .unwrap();
        *captured.lock().unwrap() = Some(server.pending().clone());

        let resp = round_trip(server.address(), r#"{"op":"never","args":{}}"#);
        assert_eq!(resp["error"], json!("timeout"));
        assert!(resp["id"].as_u64().unwrap() >= 1, "id present on timeout response");
        // The slot is cleaned up so a late reply finds no waiter.
        assert_eq!(server.pending().in_flight(), 0, "pending slot freed on timeout");
        drop(server);
    }

    /// The timeout response shape + slot cleanup, tested on the pure serve path via
    /// the registry's forget (the real serve_connection uses exactly this on timeout).
    #[test]
    fn timeout_outcome_is_error_and_frees_the_slot() {
        let reg = PendingRegistry::new();
        let (id, rx) = reg.register();
        assert_eq!(reg.in_flight(), 1);
        // Simulate the serve_connection timeout branch.
        let outcome = match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(o) => o,
            Err(_) => {
                reg.forget(id);
                ReplyOutcome::Error("timeout".to_string())
            }
        };
        assert_eq!(outcome, ReplyOutcome::Error("timeout".into()));
        assert_eq!(outcome.to_response(id), json!({"id": id, "error": "timeout"}));
        assert_eq!(reg.in_flight(), 0, "slot freed on timeout");
    }

    /// Concurrent distinct-id socket requests each receive only their own reply.
    #[test]
    fn concurrent_socket_requests_do_not_cross() {
        let tmp = TempDir::new("concurrent");
        let socket = tmp.path().join("c.sock");
        // Reply with the request's own op so we can assert no crossing. Use distinct
        // targets so they aren't serialized and truly run concurrently.
        let captured: Arc<Mutex<Option<Arc<PendingRegistry>>>> = Arc::new(Mutex::new(None));
        let cap = captured.clone();
        let server = start_control_server(&crate::ipc::socket_address(&socket), move |id, req| {
            let pending = cap.lock().unwrap().clone().unwrap();
            let pane = req.args["paneId"].as_str().unwrap_or("").to_string();
            std::thread::spawn(move || {
                // Stagger so a naive impl would cross.
                std::thread::sleep(Duration::from_millis(20));
                pending.complete(id, ReplyOutcome::Result(json!({ "pane": pane })));
            });
        })
        .unwrap();
        *captured.lock().unwrap() = Some(server.pending().clone());

        let s1 = server.address().to_string();
        let s2 = s1.clone();
        let h1 = std::thread::spawn(move || {
            round_trip(&s1, r#"{"op":"read_agent","args":{"paneId":"alpha"}}"#)
        });
        let h2 = std::thread::spawn(move || {
            round_trip(&s2, r#"{"op":"read_agent","args":{"paneId":"beta"}}"#)
        });
        let r1 = h1.join().unwrap();
        let r2 = h2.join().unwrap();
        assert_eq!(r1["result"]["pane"], json!("alpha"));
        assert_eq!(r2["result"]["pane"], json!("beta"));
        assert_ne!(r1["id"], r2["id"], "distinct request ids");
        drop(server);
    }

    /// A stale leftover socket file does not stop a fresh bind.
    #[test]
    fn stale_socket_recreated_on_boot() {
        let tmp = TempDir::new("stale");
        let socket = tmp.path().join("c.sock");
        std::fs::write(&socket, b"stale").unwrap();
        let server = start_control_server(&crate::ipc::socket_address(&socket), |_, _| {}).expect("binds despite stale file");
        let start = Instant::now();
        loop {
            if crate::ipc::connect(server.address()).is_ok() {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(2), "never became live");
        }
        drop(server);
    }
}
