use rhue::Engine;

fn main() -> Result<(), rhue::Error> {
    let mut engine = Engine::new();
    engine.register("shout", |s: String| s.to_uppercase() + "!");

    let out: String = engine.eval_as(r#"return shout("hello from rhue")"#)?;
    println!("{out}"); // HELLO FROM RHUE!
    Ok(())
}
