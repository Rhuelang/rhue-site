// things the playground leans on rhue doing, checked natively
use rhue::{DebugEvent, Engine, HookMask, Value, Variadic};
use std::{cell::RefCell, rc::Rc};

#[test]
fn module_chunk_names() {
    let mut e = Engine::new();
    e.add_module(
        "util",
        "local M = {}\nfunction M.f()\n  error('boom')\nend\nreturn M",
    );
    let seen = Rc::new(RefCell::new(Vec::new()));
    let s = seen.clone();
    e.set_debug_hook(HookMask::new().line(true), move |dbg, ev| {
        if let DebugEvent::Line(l) = ev {
            s.borrow_mut().push(format!(
                "{}:{l}:{}",
                dbg.frame(0).unwrap().source,
                dbg.depth()
            ));
        }
        Ok(())
    });
    let err = e
        .eval_named("main.rhue", "local u = require('util')\nu.f()")
        .unwrap_err();
    println!("{:?}", seen.borrow());
    println!(
        "source={} msg={} span={:?}",
        err.source_name(),
        err.diagnostic().message,
        err.diagnostic().primary.span
    );
    println!("{}", err.render(false));
}

#[test]
fn declare_and_register() {
    let mut e = Engine::new();
    e.register("lerp", |a: Variadic<Value>| -> Variadic<Value> { a });
    println!("after register: {:?}", e.global_type("lerp"));
    let r = e.declare("lerp", "(number, number, number) -> number");
    println!(
        "declare after register: {:?} -> {:?}",
        r.err().map(|e| e.diagnostic().message.clone()),
        e.global_type("lerp")
    );
    let mut e2 = Engine::new();
    e2.declare("lerp", "(number, number, number) -> number")
        .unwrap();
    e2.register("lerp", |a: Variadic<Value>| -> Variadic<Value> { a });
    println!("register after declare: {:?}", e2.global_type("lerp"));
    e2.set_default_type_mode(rhue::TypeMode::Strict);
    println!(
        "strict check bad call: {:?}",
        e2.check("x", "local x: string = lerp(1,2,3)")
            .err()
            .map(|e| e.diagnostic().message.clone())
    );
}

#[test]
fn spawn_names() {
    let mut e = Engine::new();
    let t = e
        .spawn("main.rhue", "print('hi')\nreturn 1, {a = 2}")
        .unwrap();
    println!("{:?}", matches!(t.state(), rhue::TaskState::Finished(_)));
    let err = e
        .spawn("main.rhue", "local x = 1\nerror('nope')")
        .err()
        .unwrap();
    println!(
        "spawn err source={} msg={}",
        err.source_name(),
        err.diagnostic().message
    );
    let err = e.spawn("main.rhue", "local x = = 1").err().unwrap();
    println!(
        "syntax source={} msg={} span={:?}",
        err.source_name(),
        err.diagnostic().message,
        err.diagnostic().primary.span
    );
    let mut cx = e.context();
    let g: Vec<_> = cx.globals_table().into_iter().map(|(n, _)| n).collect();
    println!("{} globals: {:?}", g.len(), &g[..g.len().min(60)]);
}
