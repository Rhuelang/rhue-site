// ─ Running scripts ───────────────────────────────────────────────────────────
// one engine per worker. the page sets it up with configure(), then run() it,
// and eval() pokes at whatever's left once the script's done

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use js_sys::{Array, Function as JsFn, Promise, Reflect};
use rhue::{
    CompileOptions, DebugEvent, Debugger, Engine, HookMask, ScriptError, TaskState, Value, Variadic,
};
use serde::Deserialize;
use serde_json::{Value as J, json};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::convert::{JsArg, JsRet, call, js_message};
use crate::lang::parse_mode;
use crate::pretty;
use crate::text::position;

// what the hook stops a script with when you hit stop in the debugger
const STOPPED: &str = "stopped from the debugger";

fn get(obj: &JsValue, key: &str) -> JsValue {
    Reflect::get(obj, &key.into()).unwrap_or(JsValue::UNDEFINED)
}

fn func(obj: &JsValue, key: &str) -> Result<JsFn, JsError> {
    get(obj, key)
        .dyn_into()
        .map_err(|_| JsError::new(&format!("configure() needs a `{key}` function")))
}

// `obj[key]` if it's an array, else an empty one
fn list(obj: &JsValue, key: &str) -> Array {
    let v = get(obj, key);
    if Array::is_array(&v) {
        v.unchecked_into()
    } else {
        Array::new()
    }
}

fn ms(now: &JsFn) -> f64 {
    now.call0(&JsValue::UNDEFINED)
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

// ─ State ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct HostStat {
    calls: u64,
    ms: f64,
}

type Stats = Rc<RefCell<HashMap<String, HostStat>>>;

#[derive(Clone)]
struct Hooks {
    print: JsFn,
    now: JsFn,
    // blocks until the page sends a command (Atomics.wait in the worker)
    pause: Option<JsFn>,
    // non-blocking, null or a command the page queued while it was running
    poll: Option<JsFn>,
}

struct State {
    engine: Option<Engine>,
    files: HashMap<String, String>,
    main: String,
    stats: Stats,
    // globals that were there before the script ran, the variables view skips them
    builtins: Rc<HashSet<String>>,
    hooks: Hooks,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// Which file a chunk name is. main runs under its file name, modules under
/// their require name
fn file_of(files: &HashMap<String, String>, source: &str) -> Option<String> {
    if files.contains_key(source) {
        return Some(source.to_string());
    }
    let with_ext = format!("{source}.rhue");
    files.contains_key(&with_ext).then_some(with_ext)
}

// ─ Setup ─────────────────────────────────────────────────────────────────────

/// Builds a fresh engine. `cfg` is
/// `{ files, main, foldConstants, typeMode, instructionLimit, memoryLimit,
/// gcStress, tasks, natives: [{ name, type, fn, async }], globals: [{ name, type,
/// value }], print, sleep, now, pause, poll }`.
/// Returns problems with host.js's types, `[{ name, message }]`
#[wasm_bindgen]
pub fn configure(cfg: JsValue) -> Result<String, JsError> {
    let hooks = Hooks {
        print: func(&cfg, "print")?,
        now: func(&cfg, "now")?,
        pause: get(&cfg, "pause").dyn_into().ok(),
        poll: get(&cfg, "poll").dyn_into().ok(),
    };
    let sleep = func(&cfg, "sleep")?;

    let fold = get(&cfg, "foldConstants").as_bool().unwrap_or(true);
    let mut engine = Engine::with_options(CompileOptions::new().fold_constants(fold));
    engine.set_default_type_mode(parse_mode(
        &get(&cfg, "typeMode").as_string().unwrap_or_default(),
    ));
    engine.set_clock(|| Duration::from_secs_f64(js_sys::Date::now() / 1000.0));
    engine.set_sleep(move |d: Duration| {
        let p = sleep.call1(
            &JsValue::UNDEFINED,
            &JsValue::from_f64(d.as_secs_f64() * 1000.0),
        );
        async move {
            if let Ok(p) = p {
                let _ = JsFuture::from(Promise::resolve(&p)).await;
            }
        }
    });
    {
        let print = hooks.print.clone();
        engine.on_print(move |s| {
            let _ = print.call1(&JsValue::UNDEFINED, &s.into());
        });
    }
    if let Some(n) = get(&cfg, "instructionLimit").as_f64() {
        engine.set_instruction_limit(Some(n as u64));
    }
    if let Some(n) = get(&cfg, "memoryLimit").as_f64() {
        engine.set_memory_limit(Some(n as usize));
    }
    // task.spawn / wait / delay, the scheduler the drivers run
    if get(&cfg, "tasks").as_bool() != Some(false) {
        engine.open_tasks();
    }
    if get(&cfg, "gcStress").as_bool() == Some(true) {
        engine.set_gc_stress(true);
    }

    let main = get(&cfg, "main")
        .as_string()
        .unwrap_or_else(|| "main.rhue".into());
    let mut files = HashMap::new();
    for f in list(&cfg, "files").iter() {
        if let (Some(path), Some(text)) = (get(&f, "path").as_string(), get(&f, "text").as_string())
        {
            files.insert(path, text);
        }
    }
    for (path, text) in &files {
        if *path != main
            && let Some(name) = path.strip_suffix(".rhue")
        {
            engine.add_module(name, text);
        }
    }

    let stats = Stats::default();
    let mut problems = Vec::new();
    for n in list(&cfg, "natives").iter() {
        let Some(name) = get(&n, "name").as_string() else {
            continue;
        };
        let Ok(f) = get(&n, "fn").dyn_into::<JsFn>() else {
            continue;
        };
        register(
            &mut engine,
            &name,
            f,
            get(&n, "async").as_bool() == Some(true),
            stats.clone(),
            hooks.now.clone(),
        );
        if let Some(ty) = get(&n, "type").as_string()
            && let Err(e) = engine.declare(&name, &ty)
        {
            problems.push(json!({ "name": name, "message": e.diagnostic().message }));
        }
    }
    for g in list(&cfg, "globals").iter() {
        let Some(name) = get(&g, "name").as_string() else {
            continue;
        };
        if let Some(ty) = get(&g, "type").as_string()
            && let Err(e) = engine.declare(&name, &ty)
        {
            problems.push(json!({ "name": name, "message": e.diagnostic().message }));
        }
        engine.set_global(&name, JsRet(get(&g, "value")));
    }

    let builtins = engine
        .context()
        .globals_table()
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            engine: Some(engine),
            files,
            main,
            stats,
            builtins: Rc::new(builtins),
            hooks,
        })
    });
    Ok(J::Array(problems).to_string())
}

fn record(stats: &Stats, name: &str, took: f64) {
    let mut s = stats.borrow_mut();
    let e = s.entry(name.to_string()).or_default();
    e.calls += 1;
    e.ms += took;
}

fn register(engine: &mut Engine, name: &str, f: JsFn, is_async: bool, stats: Stats, now: JsFn) {
    let key: Rc<str> = name.into();
    if is_async {
        engine.register_async(name, move |args: Variadic<JsArg>| {
            let (f, stats, now, key) = (f.clone(), stats.clone(), now.clone(), key.clone());
            async move {
                let started = ms(&now);
                let args: Array = args.0.into_iter().map(|a| a.0).collect();
                let out = match f.apply(&JsValue::UNDEFINED, &args) {
                    Ok(p) => JsFuture::from(Promise::resolve(&p))
                        .await
                        .map(JsRet)
                        .map_err(|e| ScriptError::new(js_message(&e))),
                    Err(e) => Err(ScriptError::new(js_message(&e))),
                };
                record(&stats, &key, ms(&now) - started);
                out
            }
        });
    } else {
        engine.register(
            name,
            move |args: Variadic<JsArg>| -> Result<JsRet, ScriptError> {
                let started = ms(&now);
                let out = call(&f, args.0.into_iter().map(|a| a.0).collect());
                record(&stats, &key, ms(&now) - started);
                out
            },
        );
    }
}

// ─ Errors ────────────────────────────────────────────────────────────────────

fn error_json(e: &rhue::Error, files: &HashMap<String, String>) -> J {
    let d = e.diagnostic();
    let file = file_of(files, e.source_name());
    let span = file.as_ref().and_then(|f| files.get(f)).map(|text| {
        (
            position(text, d.primary.span.start as usize),
            position(text, d.primary.span.end as usize),
        )
    });
    json!({
        "message": d.message,
        "rendered": e.render(false),
        "file": file,
        "start": span.map(|s| s.0),
        "end": span.map(|s| s.1),
        "stopped": d.message.contains(STOPPED),
        "interrupted": e.is_interrupted(),
    })
}

// ─ Run ───────────────────────────────────────────────────────────────────────

/// Runs main. `mode` is "run", "debug" or "profile", `breakpoints` is
/// `{ file: [{ line, condition?, hit?, log? }] }` for debug
#[wasm_bindgen]
pub async fn run(mode: String, breakpoints: String) -> Result<String, JsError> {
    let (mut engine, main, files, stats, builtins, hooks) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let s = s
            .as_mut()
            .ok_or_else(|| JsError::new("configure() first"))?;
        let engine = s
            .engine
            .take()
            .ok_or_else(|| JsError::new("already running"))?;
        Ok::<_, JsError>((
            engine,
            s.main.clone(),
            s.files.clone(),
            s.stats.clone(),
            s.builtins.clone(),
            s.hooks.clone(),
        ))
    })?;
    let source = files.get(&main).cloned().unwrap_or_default();
    stats.borrow_mut().clear();

    let profile = Rc::new(RefCell::new(Profile::default()));
    match mode.as_str() {
        "debug" => {
            let bps: HashMap<String, Vec<Bp>> =
                serde_json::from_str(&breakpoints).unwrap_or_default();
            let session = Rc::new(RefCell::new(Session {
                bps,
                hits: HashMap::new(),
                step: Step::Run,
                prev_depth: 0,
                at_depth: HashMap::new(),
                handles: Vec::new(),
                files: files.clone(),
                builtins,
                hooks: hooks.clone(),
            }));
            engine.set_debug_hook(HookMask::new().line(true), move |dbg, event| {
                session.borrow_mut().on_event(dbg, event)
            });
        }
        "profile" => {
            let p = profile.clone();
            let now = hooks.now.clone();
            let files = files.clone();
            engine.set_debug_hook(HookMask::new().line(true).call(true), move |dbg, event| {
                p.borrow_mut().on_event(dbg, event, &now, &files);
                Ok(())
            });
        }
        _ => {}
    }

    let started = ms(&hooks.now);
    let outcome = async {
        let task = engine.spawn(&main, &source)?;
        let errors = engine.run_until_idle().await;
        Ok::<_, rhue::Error>((task, errors))
    }
    .await;
    let elapsed = ms(&hooks.now) - started;
    engine.clear_debug_hook();
    let last = profile.borrow_mut().last.take();
    if let Some((key, since)) = last {
        profile.borrow_mut().add_time(key, ms(&hooks.now) - since);
    }

    let mut out = json!({ "elapsedMs": elapsed });
    match outcome {
        Ok((task, errors)) => {
            let values = match task.state() {
                TaskState::Finished(v) => v,
                // the driver finished it but only the host's resumes record results,
                // so a script that awaited something just doesn't show return values
                _ => {
                    if engine.context().thread_status(task.thread()) != "dead" {
                        out["suspended"] = J::Bool(true);
                    }
                    Vec::new()
                }
            };
            let mut cx = engine.context();
            out["values"] = values
                .iter()
                .map(|v| J::String(pretty::show(&mut cx, v, 3)))
                .collect();
            if let Some(first) = errors.first() {
                out["error"] = error_json(first, &files);
            }
            out["moreErrors"] = errors
                .iter()
                .skip(1)
                .map(|e| J::String(e.render(false)))
                .collect();
        }
        Err(e) => out["error"] = error_json(&e, &files),
    }

    let heap = engine.heap_stats();
    out["heap"] = json!({
        "bytes": heap.bytes, "strings": heap.strings, "tables": heap.tables, "functions": heap.functions,
        "userdata": heap.userdata, "threads": heap.threads, "buffers": heap.buffers,
        "collections": heap.collections,
    });
    out["memory"] = engine.memory_used().into();
    out["host"] = stats
        .borrow()
        .iter()
        .map(|(n, s)| json!({ "name": n, "calls": s.calls, "ms": s.ms }))
        .collect();
    if mode == "profile" {
        out["profile"] = profile.borrow().to_json();
    }

    STATE.with(|s| {
        if let Some(s) = s.borrow_mut().as_mut() {
            s.engine = Some(engine);
        }
    });
    Ok(out.to_string())
}

/// The console. An expression shows its value, anything else runs as a
/// statement, against whatever globals the last run left behind
#[wasm_bindgen(js_name = evaluate)]
pub async fn eval(source: String) -> Result<String, JsError> {
    let (mut engine, files) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let s = s
            .as_mut()
            .ok_or_else(|| JsError::new("configure() first"))?;
        let engine = s
            .engine
            .take()
            .ok_or_else(|| JsError::new("busy running"))?;
        Ok::<_, JsError>((engine, s.files.clone()))
    })?;
    let expr = format!("return {source}");
    let src = if engine.compile_expr("<console>", &source).is_ok()
        || engine.compile("<console>", &expr).is_ok()
    {
        expr
    } else {
        source
    };
    let out = match engine.eval_async(&src).await {
        Ok(values) => {
            let mut cx = engine.context();
            let shown: Vec<J> = values
                .iter()
                .map(|v| J::String(pretty::show(&mut cx, v, 3)))
                .collect();
            json!({ "values": shown })
        }
        Err(e) => json!({ "error": error_json(&e, &files) }),
    };
    STATE.with(|s| {
        if let Some(s) = s.borrow_mut().as_mut() {
            s.engine = Some(engine);
        }
    });
    Ok(out.to_string())
}

// ─ Debugger ──────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
struct Bp {
    line: u32,
    condition: Option<String>,
    hit: Option<String>,
    log: Option<String>,
}

#[derive(Clone, Copy)]
enum Step {
    Run,
    In,
    Over(usize),
    Out(usize),
}

struct Session {
    bps: HashMap<String, Vec<Bp>>,
    hits: HashMap<(String, u32), u64>,
    step: Step,
    prev_depth: usize,
    at_depth: HashMap<usize, (String, u32)>,
    // values the page can expand while we're stopped, by index
    handles: Vec<Value>,
    files: HashMap<String, String>,
    builtins: Rc<HashSet<String>>,
    hooks: Hooks,
}

#[derive(Deserialize)]
struct Command {
    cmd: String,
    #[serde(default)]
    id: u32,
    #[serde(default)]
    expr: String,
    #[serde(default)]
    frame: usize,
    #[serde(default)]
    r#ref: usize,
    #[serde(default)]
    bps: Option<HashMap<String, Vec<Bp>>>,
}

fn truthy(v: &[Value]) -> bool {
    !matches!(v.first(), None | Some(Value::Nil | Value::Bool(false)))
}

/// VS Code's hit conditions: "5" or ">= 5", "== 5", "> 5", "% 5"
fn hit_matches(cond: &str, hits: u64) -> bool {
    let c = cond.trim();
    let (op, n) = ["==", ">=", "<=", ">", "<", "%", "="]
        .iter()
        .find_map(|op| c.strip_prefix(op).map(|rest| (*op, rest.trim())))
        .unwrap_or((">=", c));
    let Ok(n) = n.parse::<u64>() else { return true };
    match op {
        "==" | "=" => hits == n,
        ">" => hits > n,
        "<" => hits < n,
        "<=" => hits <= n,
        "%" => n != 0 && hits % n == 0,
        _ => hits >= n,
    }
}

impl Session {
    fn on_event(&mut self, dbg: &mut Debugger<'_, '_>, event: DebugEvent) -> Result<(), String> {
        let DebugEvent::Line(line) = event else {
            return Ok(());
        };
        let mut reason = None;

        // anything the page queued while we were running
        if let Some(poll) = &self.hooks.poll
            && let Some(cmd) = poll
                .call0(&JsValue::UNDEFINED)
                .ok()
                .and_then(|v| v.as_string())
            && let Ok(cmd) = serde_json::from_str::<Command>(&cmd)
        {
            match cmd.cmd.as_str() {
                "pause" => reason = Some("pause"),
                "setBreakpoints" => self.bps = cmd.bps.unwrap_or_default(),
                "stop" => return Err(STOPPED.into()),
                _ => {}
            }
        }

        let Some(frame) = dbg.frame(0) else {
            return Ok(());
        };
        let file = file_of(&self.files, &frame.source).unwrap_or(frame.source);
        let depth = dbg.depth();
        if reason.is_none() {
            reason = match self.step {
                Step::In => Some("step"),
                Step::Over(d) if depth <= d => Some("step"),
                Step::Out(d) if depth < d => Some("step"),
                _ => None,
            };
        }
        // coming back from a call fires the caller's line again, that's not a
        // new hit for a breakpoint (stepping out should still land there)
        let returned =
            depth < self.prev_depth && self.at_depth.get(&depth) == Some(&(file.clone(), line));
        self.prev_depth = depth;
        self.at_depth.insert(depth, (file.clone(), line));
        if !returned
            && let Some(bp) = self
                .bps
                .get(&file)
                .and_then(|v| v.iter().find(|b| b.line == line))
                .cloned()
        {
            let hits = self.hits.entry((file.clone(), line)).or_default();
            *hits += 1;
            let hits = *hits;
            let cond = bp.condition.as_deref().filter(|c| !c.trim().is_empty());
            let cond_ok = cond.is_none_or(|c| dbg.eval(0, c).map(|v| truthy(&v)).unwrap_or(false));
            let hit_ok = bp
                .hit
                .as_deref()
                .filter(|h| !h.trim().is_empty())
                .is_none_or(|h| hit_matches(h, hits));
            if cond_ok && hit_ok {
                match bp.log.as_deref().filter(|l| !l.is_empty()) {
                    Some(msg) => {
                        let text = interpolate(dbg, msg);
                        let _ = self.hooks.print.call2(
                            &JsValue::UNDEFINED,
                            &text.into(),
                            &"log".into(),
                        );
                    }
                    None => reason = reason.or(Some("breakpoint")),
                }
            }
        }
        let Some(reason) = reason else { return Ok(()) };
        let Some(pause) = self.hooks.pause.clone() else {
            return Ok(());
        };

        self.step = Step::Run;
        self.handles.clear();
        let mut message = Some(self.stopped(dbg, reason, &file, line).to_string());
        loop {
            let msg = message.take().map_or(JsValue::NULL, JsValue::from);
            let reply = pause
                .call1(&JsValue::UNDEFINED, &msg)
                .map_err(|e| js_message(&e))?;
            let Some(cmd) = reply
                .as_string()
                .and_then(|r| serde_json::from_str::<Command>(&r).ok())
            else {
                continue;
            };
            match cmd.cmd.as_str() {
                "continue" => break,
                "stepIn" => {
                    self.step = Step::In;
                    break;
                }
                "stepOver" => {
                    self.step = Step::Over(depth);
                    break;
                }
                "stepOut" => {
                    self.step = Step::Out(depth);
                    break;
                }
                "stop" => return Err(STOPPED.into()),
                "setBreakpoints" => self.bps = cmd.bps.unwrap_or_default(),
                "eval" => {
                    let out = match dbg.eval(cmd.frame, &cmd.expr) {
                        Ok(values) => {
                            let v = values.into_iter().next().unwrap_or(Value::Nil);
                            json!({ "type": "reply", "id": cmd.id, "result": self.variable(dbg, &cmd.expr, v) })
                        }
                        Err(e) => json!({ "type": "reply", "id": cmd.id, "error": e }),
                    };
                    message = Some(out.to_string());
                }
                "scopes" => {
                    let scopes = self.scopes(dbg, cmd.frame);
                    message = Some(
                        json!({ "type": "reply", "id": cmd.id, "scopes": scopes }).to_string(),
                    );
                }
                "expand" => {
                    let children = self.expand(dbg, cmd.r#ref);
                    message = Some(
                        json!({ "type": "reply", "id": cmd.id, "children": children }).to_string(),
                    );
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn stopped(&mut self, dbg: &mut Debugger<'_, '_>, reason: &str, file: &str, line: u32) -> J {
        let frames: Vec<J> = dbg
            .stack()
            .into_iter()
            .map(|f| {
                let file = file_of(&self.files, &f.source);
                json!({ "function": f.function, "source": f.source, "file": file, "line": f.line })
            })
            .collect();
        let scopes = self.scopes(dbg, 0);
        json!({ "type": "stopped", "reason": reason, "file": file, "line": line, "frames": frames, "scopes": scopes })
    }

    fn scopes(&mut self, dbg: &mut Debugger<'_, '_>, level: usize) -> J {
        let locals = dbg.locals(level);
        let upvalues = dbg.upvalues(level);
        let mut globals: Vec<(String, Value)> = dbg
            .context()
            .globals_table()
            .into_iter()
            .filter(|(n, _)| !self.builtins.contains(n))
            .collect();
        globals.sort_by(|a, b| a.0.cmp(&b.0));
        let mut out = Vec::new();
        for (name, list) in [
            ("Locals", locals),
            ("Upvalues", upvalues),
            ("Globals", globals),
        ] {
            let vars: Vec<J> = list
                .into_iter()
                .map(|(n, v)| self.variable(dbg, &n, v))
                .collect();
            out.push(json!({ "name": name, "variables": vars }));
        }
        J::Array(out)
    }

    fn variable(&mut self, dbg: &mut Debugger<'_, '_>, name: &str, v: Value) -> J {
        let mut cx = dbg.context();
        let shown = pretty::show(&mut cx, &v, 1);
        let expandable = matches!(&v, Value::Table(t) if !cx.pairs(t).is_empty());
        let r = expandable.then(|| {
            self.handles.push(v.clone());
            self.handles.len() - 1
        });
        json!({ "name": name, "value": shown, "type": pretty::type_name(&v), "ref": r })
    }

    fn expand(&mut self, dbg: &mut Debugger<'_, '_>, r: usize) -> J {
        let Some(Value::Table(t)) = self.handles.get(r).cloned() else {
            return J::Array(Vec::new());
        };
        let mut pairs = dbg.context().pairs(&t);
        pairs.sort_by_key(|(k, _)| pretty::key_text(k));
        let mut out = Vec::new();
        for (k, v) in pairs.into_iter().take(500) {
            let name = match &k {
                Value::String(s) if pretty::is_name(s) => s.to_string(),
                other => format!("[{}]", pretty::show(&mut dbg.context(), other, 0)),
            };
            out.push(self.variable(dbg, &name, v));
        }
        J::Array(out)
    }
}

/// A logpoint's message, `{expr}` swapped for its value
fn interpolate(dbg: &mut Debugger<'_, '_>, msg: &str) -> String {
    let mut out = String::new();
    let mut rest = msg;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let expr = &rest[open + 1..open + close];
        match dbg.eval(0, expr) {
            Ok(v) => {
                let v = v.into_iter().next().unwrap_or(Value::Nil);
                let mut cx = dbg.context();
                match &v {
                    Value::String(s) => out.push_str(s),
                    other => out.push_str(&pretty::show(&mut cx, other, 1)),
                }
            }
            Err(e) => out.push_str(&format!("<{e}>")),
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    out
}

// ─ Profiler ──────────────────────────────────────────────────────────────────
// counts every line a script runs and roughly how long it sat on each one

#[derive(Default)]
struct Profile {
    lines: HashMap<(String, u32), (u64, f64)>,
    calls: HashMap<(String, String, u32), u64>,
    last: Option<((String, u32), f64)>,
    total: u64,
}

impl Profile {
    fn add_time(&mut self, key: (String, u32), took: f64) {
        self.lines.entry(key).or_default().1 += took;
    }

    fn on_event(
        &mut self,
        dbg: &mut Debugger<'_, '_>,
        event: DebugEvent,
        now: &JsFn,
        files: &HashMap<String, String>,
    ) {
        let Some(frame) = dbg.frame(0) else { return };
        let file = file_of(files, &frame.source).unwrap_or(frame.source);
        match event {
            DebugEvent::Line(line) => {
                let t = ms(now);
                if let Some((key, since)) = self.last.take() {
                    self.add_time(key, t - since);
                }
                self.lines.entry((file.clone(), line)).or_default().0 += 1;
                self.total += 1;
                self.last = Some(((file, line), t));
            }
            DebugEvent::Call => {
                // the chunk itself is the one call at the bottom of the stack
                let name = if dbg.depth() == 1 {
                    "main chunk".to_string()
                } else {
                    frame.function
                };
                *self.calls.entry((name, file, frame.line)).or_default() += 1;
            }
            _ => {}
        }
    }

    fn to_json(&self) -> J {
        let mut lines: Vec<J> = self
            .lines
            .iter()
            .map(|((f, l), (hits, ms))| json!({ "file": f, "line": l, "hits": hits, "ms": ms }))
            .collect();
        lines.sort_by(|a, b| {
            b["ms"]
                .as_f64()
                .partial_cmp(&a["ms"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut calls: Vec<J> = self
            .calls
            .iter()
            .map(|((name, f, l), n)| json!({ "function": name, "file": f, "line": l, "calls": n }))
            .collect();
        calls.sort_by_key(|c| std::cmp::Reverse(c["calls"].as_u64().unwrap_or(0)));
        json!({ "lines": lines, "functions": calls, "totalLines": self.total })
    }
}
