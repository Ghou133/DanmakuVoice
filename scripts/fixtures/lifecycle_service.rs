//! Test-only fake local service. Never linked into the application or release.
use std::{fs, io::{Read, Write}, net::TcpListener, process::{Command, Stdio}, time::Duration};
use std::os::windows::process::CommandExt;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let worker = args.iter().any(|arg| arg == "--worker");
    let port = if worker { 0 } else {
        args.windows(2).find(|pair| pair[0] == "-p").unwrap()[1].parse::<u16>().unwrap()
    };
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let name = if worker { "worker" } else { "service" };
    if !worker {
        Command::new(std::env::current_exe().unwrap()).arg("--worker")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(0x08000000).spawn().unwrap();
    }
    let record = format!("{{\"pid\":{},\"port\":{port}}}",std::process::id());
    fs::write(format!("{name}.tmp"), record).unwrap();
    fs::rename(format!("{name}.tmp"),format!("{name}.json")).unwrap();
    let mode = fs::read_to_string("mode.txt").unwrap_or_default();
    if !worker && mode.trim() == "fail" {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !std::path::Path::new("worker.json").exists() && std::time::Instant::now() < deadline { std::thread::yield_now(); }
        std::process::exit(17);
    }
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { break };
        let mode = mode.clone();
        std::thread::spawn(move || {
            let mut bytes = [0;4096];
            let count = stream.read(&mut bytes).unwrap_or(0);
            if count == 0 { return; }
            if mode.trim() == "starting" { std::thread::sleep(Duration::from_secs(60)); return; }
            let body = if String::from_utf8_lossy(&bytes[..count]).starts_with("GET /openapi.json ") {
                r#"{"paths":{"/tts":{"post":{}},"/set_gpt_weights":{"get":{}},"/set_sovits_weights":{"get":{}}}}"#
            } else { "{}" };
            let status = if body == "{}" {"404 Not Found"} else {"200 OK"};
            let _ = write!(stream,"HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len());
        });
    }
}
