// Mortiflix Studio window: a thin shell on the bridge UI at http://127.0.0.1:4646/. Starts bridge.mjs itself
// when nothing answers on that port (never any other port), one instance only, kills its own bridge on exit.
//
// If a Mortiflix bridge already answers on :4646 (e.g. the agents' test bridge) the window uses that one as is; any
// other program on the port is not adopted (the bridge then reports the port as taken). The bridge's log (stderr) goes
// to <app log dir>/bridge.log, and its last line is shown when it exits early.
//
// Lookup order (docs/LINUX-PACKAGING.md, docs/WINDOWS-PACKAGING.md): env MORTIFLIX_BRIDGE / MORTIFLIX_SERVICE, then
// the package resources (<resources>/app/bridge.mjs, <resources>/service/bin/mortiflix-service.mjs), then the dev
// paths (~/Documents/programs/mortiflix-app/bridge.mjs and the bridge's own default service). MORTIFLIX_NODE picks
// another node. The Windows installer also ships <resources>/node (portable Node) and <resources>/ffmpeg: both go
// first on the bridge's PATH. Linux packages use the system's node and ffmpeg (checked before the bridge starts).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const ADDR: &str = "127.0.0.1:4646";
const PORT: &str = "4646";
const URL: &str = "http://127.0.0.1:4646/";

#[derive(Default)]
struct Bridge(Mutex<Option<Child>>);

/// Pid of the bridge this window started (0 = none), for the signal handler.
static CHILD_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// Killed or logged out (SIGTERM/SIGINT/SIGHUP): the normal exit path does not run, so stop our own bridge here.
#[cfg(unix)]
extern "C" fn on_signal(_sig: libc::c_int) {
    let pid = CHILD_PID.load(std::sync::atomic::Ordering::SeqCst);
    unsafe {
        if pid > 0 { libc::kill(pid, libc::SIGTERM); }
        libc::_exit(0);
    }
}

/// The first-run check was answered with Continue in this run: don't show it again until the next start.
static FIRSTRUN_DONE: AtomicBool = AtomicBool::new(false);

/// A Mortiflix bridge answers on the port: an HTTP reply whose headers carry `x-mortiflix-bridge` (bridge.mjs sets it on
/// every reply). Any other server on 4646 (old build, unrelated program) is not taken for the bridge.
fn bridge_up() -> bool {
    let addr: SocketAddr = ADDR.parse().unwrap();
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = s.write_all(b"GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 512];
    while buf.len() < 8192 {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") { break; }
            }
        }
    }
    let head = String::from_utf8_lossy(&buf).to_ascii_lowercase();
    head.starts_with("http/") && head.contains("\r\nx-mortiflix-bridge:")
}

/// <app log dir>/bridge.log (created fresh at each bridge start), or None when the folder cannot be made.
fn bridge_log(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("bridge.log"))
}

/// Last non-empty line of the bridge log (why it stopped), or "".
fn last_log_line(log: &Option<PathBuf>) -> String {
    log.as_ref().and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| t.lines().rev().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string()))
        .unwrap_or_default()
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default())
}

fn resources(app: &AppHandle) -> Option<PathBuf> { app.path().resource_dir().ok() }
/// The renderer installed with the app (resources/renderer/node_modules/kinetograph/dist/cli.js), if any.
fn builtin_renderer(app: &AppHandle) -> Option<PathBuf> {
    let f = resources(app)?.join("renderer").join("node_modules").join("kinetograph").join("dist").join("cli.js");
    if f.is_file() { Some(f) } else { None }
}

fn bridge_path(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("MORTIFLIX_BRIDGE") { return PathBuf::from(p); }
    if let Some(r) = resources(app) {
        let p = r.join("app").join("bridge.mjs");
        if p.is_file() { return p; }
    }
    home().join("Documents/programs/mortiflix-app/bridge.mjs")
}

/// The service for the bridge's --service, or None for the bridge's own default (the dev checkout).
fn service_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MORTIFLIX_SERVICE") { return Some(PathBuf::from(p)); }
    let p = resources(app)?.join("service").join("bin").join("mortiflix-service.mjs");
    p.is_file().then_some(p)
}

fn node_path(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("MORTIFLIX_NODE") { return PathBuf::from(p); }
    if let Some(r) = resources(app) {
        let exe = if cfg!(windows) { r.join("node").join("node.exe") } else { r.join("node").join("bin").join("node") };
        if exe.is_file() { return exe; }
    }
    PathBuf::from("node")
}

fn studio_dir() -> PathBuf {
    std::env::var_os("MORTIFLIX_STUDIO").map(PathBuf::from).unwrap_or_else(|| home().join("Mortiflix"))
}

/// The bridge's PATH: a bundled Node and ffmpeg first (the Windows installer), and on Windows Claude Code's own
/// install folder (%USERPROFILE%\.local\bin: Anthropic's installer doesn't always put it on the PATH).
fn bridge_env_path(app: &AppHandle) -> Option<std::ffi::OsString> {
    let mut first: Vec<PathBuf> = Vec::new();
    if let Some(r) = resources(app) {
        let node = if cfg!(windows) { r.join("node") } else { r.join("node").join("bin") };
        // renderer/bin: the built-in renderer's command for sessions (installed with the app)
        for d in [node, r.join("ffmpeg"), r.join("renderer").join("bin")] { if d.is_dir() { first.push(d); } }
    }
    if cfg!(windows) { first.push(home().join(".local").join("bin")); }
    if first.is_empty() { return None; }
    let cur = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(first.into_iter().chain(std::env::split_paths(&cur))).ok()
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        // No console window (CREATE_NO_WINDOW); the bridge's children inherit the hidden console.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Node 20+ and ffmpeg, before the bridge starts. Err(what to tell the person).
fn check_tools(app: &AppHandle) -> Result<(), String> {
    let mut node = Command::new(node_path(app));
    if let Some(p) = bridge_env_path(app) { node.env("PATH", p); }
    let v = hidden(&mut node).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output();
    let major = v.ok().filter(|o| o.status.success())
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().trim_start_matches('v').split('.').next().and_then(|m| m.parse::<u32>().ok()));
    if !matches!(major, Some(m) if m >= 20) {
        return Err(if cfg!(windows) { "Node.js 20 or newer is needed and was not found. Reinstall Mortiflix Studio (it ships its own Node) and press Try again.".into() }
                   else { "Node.js 20 or newer is needed and was not found. Install it (Arch: sudo pacman -S nodejs, Debian/Ubuntu: sudo apt install nodejs) and press Try again.".into() });
    }
    let mut ff = Command::new("ffmpeg");
    if let Some(p) = bridge_env_path(app) { ff.env("PATH", p); }
    let ok = hidden(&mut ff).arg("-version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if !ok {
        return Err(if cfg!(windows) { "ffmpeg is needed and was not found. Reinstall Mortiflix Studio (it ships its own ffmpeg) and press Try again.".into() }
                   else { "ffmpeg is needed and was not found. Install it (Arch: sudo pacman -S ffmpeg, Debian/Ubuntu: sudo apt install ffmpeg) and press Try again.".into() });
    }
    Ok(())
}

/// Stop the bridge and everything it started (the service, its renders, its Claude Code runs).
/// Unix: SIGTERM first so the bridge's own stop runs (it closes the service's input; the service finishes the request
/// it is on, then exits), SIGKILL only if the bridge is still there after 3 s (Rust `Child::kill` = SIGKILL).
fn kill_tree(c: &mut Child) {
    if let Ok(Some(_)) = c.try_wait() { CHILD_PID.store(0, Ordering::SeqCst); return; } // already gone (pid may be reused)
    #[cfg(unix)]
    {
        unsafe { libc::kill(c.id() as libc::pid_t, libc::SIGTERM); }
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(3) {
            if let Ok(Some(_)) = c.try_wait() { CHILD_PID.store(0, Ordering::SeqCst); return; }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    #[cfg(windows)]
    {
        let mut t = Command::new("taskkill");
        let _ = hidden(&mut t).args(["/T", "/F", "/PID", &c.id().to_string()])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = c.kill();
    let _ = c.wait();
    CHILD_PID.store(0, Ordering::SeqCst);
}

/// Ok when the bridge answers; Err(reason) otherwise.
fn ensure_bridge(app: &AppHandle, state: &Bridge) -> Result<(), String> {
    if bridge_up() { return Ok(()); }
    let path = bridge_path(app);
    if !path.exists() { return Err(format!("{} not found", path.display())); }
    check_tools(app)?;
    let log = bridge_log(app);
    {
        let mut g = state.0.lock().unwrap();
        if let Some(c) = g.as_mut() { kill_tree(c); }
        let mut cmd = Command::new(node_path(app));
        cmd.arg(&path).args(["--port", PORT]);
        if let Some(s) = service_path(app) { cmd.arg("--service").arg(s); }
        if let Some(p) = bridge_env_path(app) { cmd.env("PATH", p); }
        // The built-in renderer (installed with the app): the service renders with it, nothing to install.
        if let Some(kg) = builtin_renderer(app) { cmd.env("MFX_KINETOGRAPH", kg); }
        // The real studio, with its runner on.
        cmd.env("MORTIFLIX_STUDIO", studio_dir()).env_remove("MFX_SERVICE_NO_RUNNER");
        let child = hidden(&mut cmd).current_dir(path.parent().unwrap())
            .stdin(Stdio::null()).stdout(Stdio::null())
            .stderr(log.as_ref().and_then(|p| std::fs::File::create(p).ok()).map(Stdio::from).unwrap_or_else(Stdio::null))
            .spawn().map_err(|e| format!("cannot run node: {e}"))?;
        CHILD_PID.store(child.id() as i32, std::sync::atomic::Ordering::SeqCst);
        *g = Some(child);
    }
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(20) {
        if bridge_up() { return Ok(()); }
        if let Some(c) = state.0.lock().unwrap().as_mut() {
            if let Ok(Some(st)) = c.try_wait() {
                let why = last_log_line(&log);
                return Err(if why.is_empty() { format!("bridge exited early ({st})") } else { format!("bridge exited early ({st}): {why}") });
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("bridge did not answer within 20 seconds".into())
}

/// Where the window goes once the bridge answers: /app/ (the Svelte app) when web/app/ is built, else / (today's pages).
fn start_url(app: &AppHandle) -> String {
    let built = bridge_path(app).parent().map(|d| d.join("web").join("app").join("index.html").is_file()).unwrap_or(false);
    if built { format!("{URL}app/") } else { URL.to_string() }
}

// ---- first run (Windows): Claude Code, Git for Windows (Claude Code's shell there) and the renderer ----

#[cfg(windows)]
fn on_path(names: &[&str]) -> bool {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    dirs.push(home().join(".local").join("bin"));
    dirs.iter().any(|d| names.iter().any(|n| d.join(n).is_file()))
}

#[cfg(windows)]
fn git_bash_found() -> bool {
    if let Ok(p) = std::env::var("CLAUDE_CODE_GIT_BASH_PATH") { if std::path::Path::new(&p).is_file() { return true; } }
    let mut places: Vec<PathBuf> = Vec::new();
    for k in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Ok(b) = std::env::var(k) { places.push(PathBuf::from(b).join("Git").join("bin").join("bash.exe")); }
    }
    if let Ok(l) = std::env::var("LOCALAPPDATA") { places.push(PathBuf::from(l).join("Programs").join("Git").join("bin").join("bash.exe")); }
    places.iter().any(|p| p.is_file()) || on_path(&["git.exe"])
}

/// "claude=1&git=0", or None when nothing is missing (or not Windows, or Continue was pressed).
#[cfg(not(windows))]
fn firstrun_query() -> Option<String> { None }

#[cfg(windows)]
fn firstrun_query() -> Option<String> {
    {
        if FIRSTRUN_DONE.load(Ordering::SeqCst) { return None; }
        let claude = on_path(&["claude.exe", "claude.cmd"]);
        let git = git_bash_found();
        if claude && git { return None; }
        let b = |x: bool| if x { "1" } else { "0" };
        Some(format!("claude={}&git={}", b(claude), b(git)))
    }
}

fn go(app: &AppHandle) {
    let state = app.state::<Bridge>();
    let target = match ensure_bridge(app, &state) {
        Ok(()) => match firstrun_query() {
            Some(q) => format!("window.location.replace('/firstrun.html?{q}')"),
            None => format!("window.location.replace('{}')", start_url(app)),
        },
        Err(why) => {
            let why: String = why.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').collect();
            let q = why.replace('%', "%25").replace(' ', "%20").replace('\'', "%27").replace('\\', "%5C").replace('&', "%26");
            format!("window.location.replace('/error.html?why={q}')")
        }
    };
    if let Some(w) = app.get_webview_window("main") { let _ = w.eval(&target); }
}

#[tauri::command]
fn retry(app: AppHandle) {
    std::thread::spawn(move || go(&app));
}

/// First run: Continue to the studio (what's missing can be added later in Settings).
#[tauri::command]
fn open_studio(app: AppHandle) {
    FIRSTRUN_DONE.store(true, Ordering::SeqCst);
    std::thread::spawn(move || go(&app));
}

/// First run: open a PowerShell window running the official install (or login) command, in view, so the person
/// sees and approves what runs. Nothing is installed without that window.
#[tauri::command]
fn run_in_powershell(what: String) -> Result<(), String> {
    let line = match what.as_str() {
        "claude" => "irm https://claude.ai/install.ps1 | iex",
        "claude-login" => "claude",
        "git" => "winget install --id Git.Git -e --source winget",
        _ => return Err("unknown".into()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("powershell.exe");
        // %USERPROFILE%\.local\bin first: where the Claude Code installer puts claude.exe.
        if let Ok(p) = std::env::join_paths(std::iter::once(home().join(".local").join("bin"))
            .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()))) { c.env("PATH", p); }
        c.args(["-NoExit", "-NoProfile", "-Command", line])
            .creation_flags(0x0000_0010) // CREATE_NEW_CONSOLE: a window the person sees
            .spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    { Err(format!("run this in a terminal: {line}")) }
}

/// One instance on Windows: a lock file opened with no sharing. Windows closes it when this process ends.
#[cfg(windows)]
fn single_instance() -> Option<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    let dir = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Mortiflix Studio");
    let _ = std::fs::create_dir_all(&dir);
    std::fs::OpenOptions::new().read(true).write(true).create(true).share_mode(0).open(dir.join("instance.lock")).ok()
}

/// One instance: a unix socket in the runtime dir. A live owner means we quit; a stale file is replaced.
#[cfg(unix)]
fn single_instance() -> Option<std::os::unix::net::UnixListener> {
    use std::os::unix::net::{UnixListener, UnixStream};
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    let p = PathBuf::from(dir).join("mortiflix-studio.lock");
    if let Ok(l) = UnixListener::bind(&p) { return Some(l); }
    if UnixStream::connect(&p).is_ok() { return None; }
    let _ = std::fs::remove_file(&p);
    UnixListener::bind(&p).ok()
}

fn main() {
    let _guard = match single_instance() { Some(g) => g, None => return };
    #[cfg(unix)]
    unsafe {
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(sig, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        }
    }

    let app = tauri::Builder::default()
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![retry, open_studio, run_in_powershell])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Mortiflix Studio")
                .inner_size(1600.0, 900.0)
                .min_inner_size(1366.0, 768.0)
                .resizable(true).maximized(true)
                .build()?;
            let h = app.handle().clone();
            std::thread::spawn(move || go(&h));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Mortiflix Studio");

    app.run(|h, e| {
        if let RunEvent::Exit = e {
            if let Some(c) = h.state::<Bridge>().0.lock().unwrap().as_mut() { kill_tree(c); }
        }
    });
}
