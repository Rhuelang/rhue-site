// ─ Examples ──────────────────────────────────────────────────────────────────
// each one is a whole workspace. main.rhue is what runs

import { HOST_TEMPLATE } from "./host";

export type Example = {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  files: Record<string, string>;
  /** a file to open next to main.rhue */
  focus?: string;
};

const welcome = `--!nonstrict
-- Welcome to the Rhue playground. Everything here runs in your browser:
-- the compiler, the type checker, the VM and the language server, all built
-- to wasm from the same crates you'd put in Cargo.toml.
--
--   F5         debug (click the gutter for breakpoints first)
--   Ctrl+F5    run
--   F1         every command, Ctrl+Space completion, F2 rename
--
-- Hover anything for its type. util.rhue is a module, require() finds it.

local util = require("util")

type Pet = { name: string, kind: "dog" | "cat" | "wolf", age: number }

local pets: { Pet } = {
    { name = "Aalto", kind = "wolf", age = 4 },
    { name = "Biscuit", kind = "dog", age = 9 },
    { name = "Smokey", kind = "cat", age = 2 },
}

table.sort(pets, function(a, b)
    return a.age < b.age
end)

for i, pet in pets do
    print(\`{i}. {pet.name} the {pet.kind}, {util.plural(pet.age, "year")} old\`)
end

local total = 0
for _, pet in pets do
    total += pet.age
end
print(\`average age: {util.round(total / #pets, 1)}\`)

-- whatever main returns shows up in Output
return pets[1]
`;

const welcomeUtil = `--!strict
-- a module. whatever it returns is what require("util") gives you, and its
-- types come along, hover util.plural over in main.rhue

local util = {}

function util.plural(n: number, word: string): string
    return \`{n} {word}{if n == 1 then "" else "s"}\`
end

function util.round(x: number, places: number?): number
    local scale = 10 ^ (places or 0)
    return math.floor(x * scale + 0.5) / scale
end

return util
`;

const classes = `-- classes the Luau way: a table for the methods, setmetatable for instances,
-- and __index to chain a subclass onto its parent

local Account = {}
Account.__index = Account

function Account.new(owner: string, balance: number?)
    return setmetatable({ owner = owner, balance = balance or 0, history = {} }, Account)
end

function Account:deposit(amount: number)
    assert(amount > 0, "deposit something")
    self.balance += amount
    table.insert(self.history, \`+{amount}\`)
end

function Account:withdraw(amount: number)
    if amount > self.balance then
        error(\`{self.owner} only has {self.balance}\`)
    end
    self.balance -= amount
    table.insert(self.history, \`-{amount}\`)
end

Account.__tostring = function(self)
    return \`{self.owner}: {self.balance} ({table.concat(self.history, " ")})\`
end

-- a savings account is an account that earns interest
local Savings = setmetatable({}, { __index = Account })
Savings.__index = Savings
Savings.__tostring = Account.__tostring

function Savings.new(owner: string, rate: number)
    local acct = Account.new(owner)
    acct.rate = rate
    return setmetatable(acct, Savings)
end

function Savings:accrue()
    self:deposit(math.floor(self.balance * self.rate))
end

local zae = Savings.new("Zae", 0.05)
zae:deposit(1000)
zae:accrue()
zae:withdraw(200)
print(tostring(zae))

-- errors are values too. pcall catches this one
local ok, why = pcall(function()
    zae:withdraw(1e6)
end)
print(ok, why)
`;

const types = `--!strict
-- strict mode checks everything, and a type error stops the script before it
-- runs. there are three mistakes at the bottom on purpose. hover the squiggles,
-- and Ctrl+. on one for a quick fix when there is one

type Point = { x: number, y: number }
type Named<T> = { name: string, value: T }

local function add(a: Point, b: Point): Point
    return { x = a.x + b.x, y = a.y + b.y }
end

-- generics
local function map<T, U>(list: { T }, f: (T) -> U): { U }
    local out = {}
    for i, v in list do
        out[i] = f(v)
    end
    return out
end

local function label<T>(name: string, value: T): Named<T>
    return { name = name, value = value }
end

local points: { Point } = { { x = 1, y = 2 }, { x = 3, y = 4 } }
local sum = add(points[1], points[2])
local names = map(points, function(p)
    return \`({p.x}, {p.y})\`
end)
print(table.concat(names, " + "), "=", \`({sum.x}, {sum.y})\`)

local tagged = label("origin", { x = 0, y = 0 })
print(tagged.name, tagged.value.x)

-- 1. a string where a number goes
local total: number = "lots"

-- 2. a typo in a field name
print(sum.z)

-- 3. something that might be nil
local function find(name: string): Point?
    return nil
end
print(find("home").x)
`;

const coroutines = `-- coroutines are functions that can pause. generators fall right out of them

local function range(from: number, to: number, step: number?)
    return coroutine.wrap(function()
        for i = from, to, step or 1 do
            coroutine.yield(i)
        end
    end)
end

local function take(gen, n: number)
    local out = {}
    for v in gen do
        table.insert(out, v)
        if #out == n then
            break
        end
    end
    return out
end

local function fib()
    return coroutine.wrap(function()
        local a, b = 0, 1
        while true do
            coroutine.yield(a)
            a, b = b, a + b
        end
    end)
end

print(table.concat(take(range(1, 100, 7), 5), " "))
print(table.concat(take(fib(), 15), " "))

-- __iter makes a table work in a plain for loop
local Bag = {}
Bag.__index = Bag
Bag.__iter = function(self)
    return next, self.items
end

local bag = setmetatable({ items = { apple = 3, pear = 1 } }, Bag)
for fruit, n in bag do
    print(fruit, n)
end
`;

const asyncHost = `-- host.js has fetchScore, an async function. the script waits on it without
-- blocking anything, and task.wait / task.spawn run on the same scheduler

print("asking the host...")
local score = fetchScore("Aalto")
print(\`Aalto scored {score}\`)

local done = 0
for _, name in { "Biscuit", "Smokey", "Fern" } do
    task.spawn(function()
        local s = fetchScore(name)
        print(\`  {name}: {s}\`)
        done += 1
    end)
end

while done < 3 do
    task.wait(0.05)
end
print(\`all in, CONFIG.level is {CONFIG.level}\`)
`;

const perfHost = `// two ways to do the same work: in Rhue, and as a native the script calls.
// open Engine on the left to see how many times each native got called and
// how long the engine spent in it

host.fn("sumNative", "({number}) -> number", (list) => {
  let s = 0;
  for (const x of list) s += x;
  return s;
});

host.fn("noise", "(number, number) -> number", (x, y) => {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
});

host.fn("now", "() -> number", () => performance.now());
`;

const perf = `-- Rhue vs a host native doing the same sum, then a noise field that calls
-- into the host 10k times. Profile (in the run menu) shows where it goes

local list = table.create(200000, 0)
for i = 1, #list do
    list[i] = i % 7
end

local function sumRhue(xs: { number }): number
    local s = 0
    for _, x in xs do
        s += x
    end
    return s
end

local t0 = now()
local a = sumRhue(list)
local t1 = now()
local b = sumNative(list)
local t2 = now()
print(\`rhue:   {a} in {string.format("%.2f", t1 - t0)} ms\`)
print(\`native: {b} in {string.format("%.2f", t2 - t1)} ms (that includes copying the table into js)\`)

local field = 0
for y = 1, 100 do
    for x = 1, 100 do
        field += noise(x, y)
    end
end
print(\`noise field average: {string.format("%.4f", field / 10000)}\`)
`;

const debugTour = `-- a little tour of the debugger:
--
-- 1. click left of line 21 for a breakpoint, then F5
-- 2. look at Variables, hover things, type in the Debug Console
-- 3. F10 steps over, F11 steps into score(), Shift+F11 back out
-- 4. right-click a breakpoint for a condition like  i == 4  or a logpoint
--    like  {name} has {#name} letters  that prints instead of stopping

local function score(name: string): number
    local s = 0
    for i = 1, #name do
        s += string.byte(name, i) * i
    end
    return s % 100
end

local names = { "Aalto", "Fern", "Biscuit", "Smokey", "Rhue" }
local best, bestScore = nil, -1
for i, name in names do
    local s = score(name)
    if s > bestScore then
        best, bestScore = name, s
    end
end

print(\`{best} wins with {bestScore}\`)
`;

const fib = `-- something to profile. pick Profile from the run menu and the hot lines get
-- coloured in the editor, with hit counts and time next to them

local function fib(n: number): number
    if n < 2 then
        return n
    end
    return fib(n - 1) + fib(n - 2)
end

local memo = {}
local function fibMemo(n: number): number
    if n < 2 then
        return n
    end
    local hit = memo[n]
    if hit then
        return hit
    end
    local v = fibMemo(n - 1) + fibMemo(n - 2)
    memo[n] = v
    return v
end

local start = os.clock()
print(\`fib(24) = {fib(24)}\`, string.format("%.1f ms", (os.clock() - start) * 1000))
start = os.clock()
print(\`fibMemo(80) = {fibMemo(80)}\`, string.format("%.3f ms", (os.clock() - start) * 1000))
`;

const bytes = `-- buffers are fixed-size byte arrays, vectors are three floats with operators

local b = buffer.create(16)
buffer.writeu32(b, 0, 0xDEADBEEF)
buffer.writef32(b, 4, 3.5)
buffer.writestring(b, 8, "rhue!")
print(string.format("%08X", buffer.readu32(b, 0)), buffer.readf32(b, 4), buffer.readstring(b, 8, 5))

local hex = {}
for i = 0, buffer.len(b) - 1 do
    table.insert(hex, string.format("%02x", buffer.readu8(b, i)))
end
print(table.concat(hex, " "))

local p = vector.create(1, 2, 3)
local q = vector.create(4, 5, 6)
print(p + q, p * 2, vector.dot(p, q), vector.magnitude(q))

-- bit32 for the fiddly bits
print(bit32.band(0xFF, 0x0F), bit32.lshift(1, 10), bit32.bxor(0b1010, 0b0110))
`;

const patterns = `-- string patterns, Lua style (not regex, but close enough most days)

local log = [[
2026-11-20 01:22 INFO  user=zae action=login
2026-11-20 01:23 WARN  user=fern action=retry attempts=3
2026-11-20 01:25 ERROR user=zae action=deploy reason="zone does not exist"
]]

for time, level, rest in string.gmatch(log, "%d+%-%d+%-%d+ (%d+:%d+) (%u+)%s+([^\\n]*)") do
    local fields = {}
    for k, v in string.gmatch(rest, "(%w+)=(%S+)") do
        fields[k] = v
    end
    -- a quoted value has spaces in it, grab it separately
    fields.reason = string.match(rest, 'reason="([^"]*)"')
    print(level, time, fields.user, fields.action, fields.reason or fields.attempts or "")
end

print(string.gsub("hello world", "o", "0"))
print(string.find("rhue.dev", ".", 1, true))
print(string.format("%-8s|%5.1f|%x", "left", math.pi, 255))
print(utf8.len("wölf 🐺"), #"wölf 🐺")
`;

export const EXAMPLES: Example[] = [
  { id: "welcome", title: "Welcome", icon: "waving_hand", blurb: "Types, tables, interpolation and a module", files: { "main.rhue": welcome, "util.rhue": welcomeUtil } },
  { id: "debugger", title: "Debugger tour", icon: "bug_report", blurb: "Breakpoints, stepping, conditions and logpoints", files: { "main.rhue": debugTour } },
  { id: "host", title: "Host natives", icon: "memory", blurb: "Add functions to the engine from host.js, async ones too", files: { "main.rhue": asyncHost, "host.js": HOST_TEMPLATE }, focus: "host.js" },
  { id: "perf", title: "Rhue vs native", icon: "speed", blurb: "The same work in a script and in the host, timed", files: { "main.rhue": perf, "host.js": perfHost } },
  { id: "profile", title: "Profiling", icon: "local_fire_department", blurb: "Hot lines, hit counts, naive vs memoized fib", files: { "main.rhue": fib } },
  { id: "classes", title: "Classes", icon: "account_tree", blurb: "Metatables, inheritance, __tostring and pcall", files: { "main.rhue": classes } },
  { id: "types", title: "Strict types", icon: "verified", blurb: "Unions, generics, and mistakes for the checker to find", files: { "main.rhue": types } },
  { id: "coroutines", title: "Coroutines", icon: "sync_alt", blurb: "Generators, coroutine.wrap and __iter", files: { "main.rhue": coroutines } },
  { id: "bytes", title: "Buffers and vectors", icon: "data_array", blurb: "Byte buffers, vector math and bit32", files: { "main.rhue": bytes } },
  { id: "patterns", title: "String patterns", icon: "text_fields", blurb: "gmatch, gsub, format and utf8", files: { "main.rhue": patterns } },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
