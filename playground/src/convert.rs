// ─ JS <-> Rhue ───────────────────────────────────────────────────────────────
// how values cross between host.js and scripts

use js_sys::{Array, Function as JsFn, Object, Reflect, Uint8Array};
use rhue::{Context, ConversionError, FromValue, IntoValue, ScriptError, Value, Variadic};
use wasm_bindgen::{JsCast, JsValue};

// deep enough for real data, shallow enough that a table that holds itself stops
const MAX_DEPTH: u32 = 24;

/// A script value on its way into JS (the argument side of a native)
pub struct JsArg(pub JsValue);

impl FromValue for JsArg {
    fn from_value(value: Value, cx: &mut Context<'_>) -> Result<Self, ConversionError> {
        Ok(JsArg(to_js(cx, &value, 0)))
    }
}

/// A JS value on its way into a script (what a native returns)
pub struct JsRet(pub JsValue);

impl IntoValue for JsRet {
    fn into_value(self, cx: &mut Context<'_>) -> Value {
        from_js(cx, &self.0, 0)
    }
}

pub fn to_js(cx: &mut Context<'_>, v: &Value, depth: u32) -> JsValue {
    match v {
        Value::Nil => JsValue::UNDEFINED,
        Value::Bool(b) => JsValue::from_bool(*b),
        Value::Number(n) => JsValue::from_f64(*n),
        Value::String(s) => JsValue::from_str(s),
        Value::Vector([x, y, z]) => {
            let o = Object::new();
            for (k, n) in [("x", x), ("y", y), ("z", z)] {
                let _ = Reflect::set(&o, &k.into(), &JsValue::from_f64(f64::from(*n)));
            }
            o.into()
        }
        Value::Buffer(b) => Uint8Array::from(&cx.buffer_bytes(b)[..]).into(),
        Value::Table(t) if depth < MAX_DEPTH => {
            let len = cx.len(t);
            let pairs = cx.pairs(t);
            if len > 0 && pairs.len() == len {
                // a plain list, keys 1..n
                let out = Array::new_with_length(u32::try_from(len).unwrap_or(u32::MAX));
                for (k, v) in &pairs {
                    if let Value::Number(n) = k {
                        out.set((*n as u32).saturating_sub(1), to_js(cx, v, depth + 1));
                    }
                }
                out.into()
            } else {
                let o = Object::new();
                for (k, v) in &pairs {
                    let key = match k {
                        Value::String(s) => JsValue::from_str(s),
                        other => JsValue::from_str(&other.to_string()),
                    };
                    let _ = Reflect::set(&o, &key, &to_js(cx, v, depth + 1));
                }
                o.into()
            }
        }
        // functions, threads and userdata can't be used from js, it gets a label
        other => JsValue::from_str(&other.to_string()),
    }
}

pub fn from_js(cx: &mut Context<'_>, js: &JsValue, depth: u32) -> Value {
    if js.is_undefined() || js.is_null() {
        return Value::Nil;
    }
    if let Some(b) = js.as_bool() {
        return Value::Bool(b);
    }
    if let Some(n) = js.as_f64() {
        return Value::Number(n);
    }
    if let Some(s) = js.as_string() {
        return Value::String(s.into());
    }
    if js.is_bigint() {
        return Value::Number(js_sys::Number::from(js.clone()).value_of());
    }
    if depth >= MAX_DEPTH {
        return Value::Nil;
    }
    if let Some(bytes) = js.dyn_ref::<Uint8Array>() {
        return Value::Buffer(cx.create_buffer(&bytes.to_vec()));
    }
    if js.is_function() {
        let f: JsFn = js.clone().unchecked_into();
        let name = f
            .name()
            .as_string()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "<js>".into());
        let func = cx.create_function(
            &name,
            move |args: Variadic<JsArg>| -> Result<JsRet, ScriptError> {
                call(&f, args.0.into_iter().map(|a| a.0).collect())
            },
        );
        return Value::Function(func);
    }
    let t = cx.new_table();
    if Array::is_array(js) {
        let arr: &Array = js.unchecked_ref();
        for (i, item) in arr.iter().enumerate() {
            let v = from_js(cx, &item, depth + 1);
            let _ = cx.set(&t, (i + 1) as f64, v);
        }
    } else if js.is_object() {
        for entry in Object::entries(js.unchecked_ref()).iter() {
            let pair: Array = entry.unchecked_into();
            let key = pair.get(0).as_string().unwrap_or_default();
            let v = from_js(cx, &pair.get(1), depth + 1);
            // numeric-looking keys stay numbers, so {1: "a"} round trips as a list
            match key.parse::<f64>() {
                Ok(n) if n.fract() == 0.0 => {
                    let _ = cx.set(&t, n, v);
                }
                _ => {
                    let _ = cx.set(&t, key.as_str(), v);
                }
            }
        }
    }
    Value::Table(t)
}

/// Calls a host.js function, a throw turns into a script error (pcall catches it)
pub fn call(f: &JsFn, args: Vec<JsValue>) -> Result<JsRet, ScriptError> {
    let arr: Array = args.into_iter().collect();
    f.apply(&JsValue::UNDEFINED, &arr)
        .map(JsRet)
        .map_err(|e| ScriptError::new(js_message(&e)))
}

pub fn js_message(e: &JsValue) -> String {
    if let Some(s) = e.as_string() {
        return s;
    }
    Reflect::get(e, &"message".into())
        .ok()
        .and_then(|m| m.as_string())
        .unwrap_or_else(|| format!("{e:?}"))
}
