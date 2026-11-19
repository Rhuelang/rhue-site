engine.register("ask", |question: String| -> Result<String, ScriptError> {
    Err(ScriptError::yield_with(vec![Value::from(question)])) // pause here
});

let mut dialog = engine.spawn("npc.rhue", r#"
    local name = ask("What's your name?")
    return "Nice to meet you, " .. name
"#)?;

// dialog.state() == Suspended(["What's your name?"])
engine.resume(&mut dialog, vec![Value::from("Aalto")])?;
// dialog.state() == Finished(["Nice to meet you, Aalto"])
