// A Pine Script interpreter for scripts written for TradingView: indicator() and strategy() scripts
// in Pine v5/v6 syntax, run once per bar the way TradingView runs them. It covers the common
// language (variables, var, if/for/while/switch, functions, tuples, history with []) and the most
// used built-ins (ta.*, math.*, str.*, input.*, color.*, plot, plotshape, plotchar, hline and
// strategy.*). Anything outside that stops with its line number, so a script either runs as
// written or says why not. Labels, lines, boxes, tables, fills and background colours are accepted
// and skipped (listed as warnings), so a script that only decorates with them still runs.
import { stats } from "./backtest.js";

export class PineError extends Error {
  constructor(message, line = 0, col = 0) {
    super(line ? `line ${line}: ${message}` : message);
    this.plain = message;
    this.line = line;
    this.col = col;
  }
}

// ======================================================================= lexer
const KEYWORDS = new Set(["and", "or", "not", "if", "else", "for", "to", "by", "while", "var", "varip", "true", "false", "switch", "break", "continue", "in", "import", "export", "method", "type"]);
const TYPES = new Set(["int", "float", "bool", "color", "string", "line", "label", "box", "table", "series", "simple", "const", "linefill", "polyline"]);
const OPS2 = [":=", "==", "!=", "<=", ">=", "=>", "+=", "-=", "*=", "/=", "%="];
const CONTINUES = new Set(["+", "-", "*", "/", "%", "and", "or", "?", ":", ",", "==", "!=", "<", ">", "<=", ">=", "=", ":=", "not", "(", "["]);

function lex(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const toks = [];
  const indents = [0];
  let depth = 0;
  const push = (type, value, line, col) => toks.push({ type, value, line, col });
  const lastSig = () => {
    for (let k = toks.length - 1; k >= 0; k--) if (toks[k].type !== "nl") return toks[k];
    return null;
  };
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln],
      line = ln + 1;
    let i = 0,
      ind = 0;
    while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) {
      ind += raw[i] === "\t" ? 4 : 1;
      i++;
    }
    const rest = raw.slice(i);
    if (!rest.trim() || rest.startsWith("//")) continue;
    const prev = lastSig();
    const continues = depth > 0 || (prev && (prev.type === "op" || prev.type === "kw") && CONTINUES.has(prev.value)) || (toks.length && ind % 4 !== 0 && ind > indents.at(-1));
    if (!continues) {
      if (toks.length && toks.at(-1).type !== "nl") push("nl", null, line - 1, 0);
      if (ind > indents.at(-1)) {
        indents.push(ind);
        push("indent", null, line, 0);
      } else
        while (ind < indents.at(-1)) {
          indents.pop();
          push("dedent", null, line, 0);
          if (ind > indents.at(-1)) throw new PineError("this line's indentation doesn't match any block above it", line);
        }
    }
    while (i < raw.length) {
      const c = raw[i],
        col = i + 1;
      if (c === " " || c === "\t") {
        i++;
        continue;
      }
      if (c === "/" && raw[i + 1] === "/") break;
      const num = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(raw.slice(i));
      if (num && !(c === "." && !/\d/.test(raw[i + 1] || ""))) {
        push("num", Number(num[1]), line, col);
        if (/[.eE]/.test(num[1])) toks.at(-1).float = true;
        i += num[1].length;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1,
          s = "";
        while (j < raw.length && raw[j] !== c) {
          if (raw[j] === "\\" && j + 1 < raw.length) {
            const e = raw[j + 1];
            s += e === "n" ? "\n" : e === "t" ? "\t" : e;
            j += 2;
          } else s += raw[j++];
        }
        if (j >= raw.length) throw new PineError("this string has no closing quote", line, col);
        push("str", s, line, col);
        i = j + 1;
        continue;
      }
      if (c === "#") {
        const m = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/.exec(raw.slice(i));
        if (!m) throw new PineError("a colour is written #RRGGBB or #RRGGBBAA", line, col);
        push("color", hexColor(m[0]), line, col);
        i += m[0].length;
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(raw.slice(i));
      if (id) {
        const w = id[0];
        push(KEYWORDS.has(w) ? "kw" : "id", w, line, col);
        i += w.length;
        continue;
      }
      const two = raw.slice(i, i + 2);
      if (OPS2.includes(two)) {
        push("op", two, line, col);
        i += 2;
        continue;
      }
      if ("+-*/%<>=?:,()[].".includes(c)) {
        if (c === "(" || c === "[") depth++;
        if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
        push("op", c, line, col);
        i++;
        continue;
      }
      throw new PineError(`unexpected character "${c}"`, line, col);
    }
  }
  push("nl", null, lines.length, 0);
  while (indents.length > 1) {
    indents.pop();
    push("dedent", null, lines.length, 0);
  }
  push("eof", null, lines.length, 0);
  return toks;
}

// ======================================================================= parser
let NODE_ID = 0;
const node = (type, t, props) => ({ type, id: ++NODE_ID, line: t?.line || 0, ...props });

class Parser {
  constructor(toks) {
    this.t = toks;
    this.k = 0;
    // "type" starts a type only as "type Name" at the start of a line; anywhere else it's a name, as in
    // getMA(type, src, len) => or type == "EMA"
    for (let i = 0; i < toks.length; i++) {
      const x = toks[i];
      if (x.type === "kw" && x.value === "type" && !(toks[i + 1]?.type === "id" && (i === 0 || ["nl", "indent", "dedent"].includes(toks[i - 1].type)))) x.type = "id";
    }
    this.udts = new Set(); // the script's own types, so "Pool p = ..." reads as a declaration
  }
  peek(o = 0) {
    return this.t[this.k + o];
  }
  next() {
    return this.t[this.k++];
  }
  is(type, value, o = 0) {
    const t = this.peek(o);
    return t && t.type === type && (value === undefined || t.value === value);
  }
  eat(type, value) {
    if (this.is(type, value)) return this.next();
    const t = this.peek();
    const want = value ?? { nl: "the end of the line", indent: "an indented block", dedent: "the end of the block", id: "a name" }[type] ?? type;
    const got = t.type === "nl" ? "the end of the line" : t.type === "eof" ? "the end of the script" : t.type === "indent" ? "an indented line" : t.type === "dedent" ? "the end of the block" : `"${t.value}"`;
    throw new PineError(`expected ${want}, found ${got}`, t.line, t.col);
  }
  skipNl() {
    while (this.is("nl")) this.next();
  }
  program() {
    const body = [];
    this.skipNl();
    while (!this.is("eof")) {
      this.statements(body);
      this.endStatement();
    }
    return node("Block", this.peek(), { body });
  }
  endStatement() {
    // a statement that ended with a block (if, for, a function) already ended its line
    if (this.is("eof") || this.is("dedent") || this.t[this.k - 1]?.type === "dedent") return;
    this.eat("nl");
    this.skipNl();
  }
  block() {
    this.eat("nl");
    this.skipNl();
    const start = this.eat("indent");
    const body = [];
    while (!this.is("dedent") && !this.is("eof")) {
      this.statements(body);
      this.endStatement();
    }
    if (this.is("dedent")) this.next();
    return node("Block", start, { body });
  }
  // One statement, or several on one line split by commas (a = 1, b = 2); a comma at the end of a line only
  // joins the next line to it.
  statements(body) {
    body.push(this.statement());
    while (this.is("op", ",") && this.t[this.k - 1]?.type !== "dedent") {
      this.next();
      if (this.is("nl") || this.is("eof") || this.is("dedent")) break;
      body.push(this.statement());
    }
  }
  // a function body or an if/for branch: either a block on the next lines or one expression
  bodyAfter() {
    if (this.is("nl")) return this.block();
    const e = this.expr();
    return node("Block", e, { body: [e] });
  }
  statement() {
    const t = this.peek();
    if (t.type === "kw") {
      if (["import", "export", "method"].includes(t.value))
        throw new PineError(`"${t.value}" (libraries and methods) isn't supported here yet`, t.line, t.col);
      if (t.value === "type") return this.typeDef();
      if (t.value === "if") return this.ifStmt();
      if (t.value === "for") return this.forStmt();
      if (t.value === "while") return this.whileStmt();
      if (t.value === "switch") return this.switchStmt();
      if (t.value === "break" || t.value === "continue") {
        this.next();
        return node(t.value === "break" ? "Break" : "Continue", t, {});
      }
      if (t.value === "var" || t.value === "varip") {
        this.next();
        this.skipTypes();
        return this.declaration(true);
      }
    }
    if (t.type === "op" && t.value === "[" && this.tupleAhead()) return this.tupleDecl();
    if (t.type === "id") {
      if (this.is("op", "(", 1) && this.funcAhead()) return this.funcDef();
      const tl = this.typeLen(0);
      if (tl && this.is("id", undefined, tl) && this.is("op", "=", tl + 1)) {
        this.skipTypes();
        return this.declaration(false);
      }
      if (this.is("op", "=", 1)) return this.declaration(false);
      if (this.is("op", undefined, 1) && [":=", "+=", "-=", "*=", "/=", "%="].includes(this.peek(1).value)) {
        const name = this.next(),
          op = this.next();
        return node("Assign", name, { name: name.value, op: op.value, value: this.exprOrIf() });
      }
    }
    return node("ExprStmt", t, { expr: this.exprOrIf() });
  }
  // A type written before a name: int, series float, color, line, a type of the script's own,
  // array<float>, map<string, float>, float[]. Returns how many tokens it takes, or 0.
  typeLen(o = 0) {
    let k = o;
    while (this.is("id", undefined, k) && ["series", "simple", "const"].includes(this.peek(k).value)) k++;
    const t = this.peek(k);
    if (!t || t.type !== "id") return 0;
    if (["array", "matrix", "map"].includes(t.value) && this.is("op", "<", k + 1)) {
      const g = this.genericLen(k + 1);
      return g ? k + 1 + g - o : 0;
    }
    if (!TYPES.has(t.value) && !this.udts.has(t.value)) return 0;
    if (this.is("op", "[", k + 1) && this.is("op", "]", k + 2)) return k + 3 - o;
    return k + 1 - o;
  }
  // <type, type> starting at offset o: how many tokens up to and including the closing >, or 0.
  genericLen(o) {
    let d = 0;
    for (let j = o; this.peek(j); j++) {
      const x = this.peek(j);
      if (x.type === "op" && x.value === "<") d++;
      else if (x.type === "op" && x.value === ">") {
        if (--d === 0) return j + 1 - o;
      } else if (!(x.type === "id" || (x.type === "op" && (x.value === "," || x.value === "[" || x.value === "]")))) return 0;
    }
    return 0;
  }
  skipTypes() {
    for (let n = this.typeLen(0); n && this.is("id", undefined, n); n = this.typeLen(0)) this.k += n;
  }
  // type Pool
  //     float lvl
  //     int born = 0
  typeDef() {
    const t = this.eat("kw", "type");
    const name = this.eat("id");
    if (name.value.includes(".")) throw new PineError("a type's name can't contain a dot", name.line, name.col);
    this.udts.add(name.value);
    this.eat("nl");
    this.skipNl();
    this.eat("indent");
    const fields = [];
    while (!this.is("dedent") && !this.is("eof")) {
      const n = this.typeLen(0);
      if (!n || !this.is("id", undefined, n)) throw new PineError("each field is written as a type and a name, for example: float price", this.peek().line);
      this.k += n;
      const f = this.eat("id");
      if (f.value.includes(".") || fields.some((x) => x.name === f.value)) throw new PineError(`"${f.value}" isn't a valid field name here`, f.line, f.col);
      let def = null;
      if (this.is("op", "=")) {
        this.next();
        def = this.expr();
      }
      fields.push({ name: f.value, def });
      this.endStatement();
    }
    if (this.is("dedent")) this.next();
    return node("TypeDef", t, { name: name.value, fields });
  }
  declaration(persistent) {
    const name = this.eat("id");
    if (name.value.includes(".")) throw new PineError(`use := to change "${name.value}"`, name.line, name.col);
    this.eat("op", "=");
    return node("Decl", name, { name: name.value, persistent, value: this.exprOrIf() });
  }
  tupleAhead() {
    let k = 1;
    while (this.is("id", undefined, k) && (this.is("op", ",", k + 1) || this.is("op", "]", k + 1))) {
      if (this.is("op", "]", k + 1)) return this.is("op", "=", k + 2) || this.is("op", ":=", k + 2);
      k += 2;
    }
    return false;
  }
  tupleDecl() {
    const t = this.eat("op", "[");
    const names = [];
    do names.push(this.eat("id").value);
    while (this.is("op", ",") && this.next());
    this.eat("op", "]");
    const op = this.next();
    return node("TupleDecl", t, { names, reassign: op.value === ":=", value: this.exprOrIf() });
  }
  funcAhead() {
    let k = 1,
      d = 0;
    for (; this.peek(k) && this.peek(k).type !== "eof"; k++) {
      const t = this.peek(k);
      if (t.type === "op" && t.value === "(") d++;
      if (t.type === "op" && t.value === ")" && --d === 0) return this.is("op", "=>", k + 1);
      if (t.type === "nl" && d === 0) return false;
    }
    return false;
  }
  funcDef() {
    const name = this.next();
    this.eat("op", "(");
    const params = [];
    while (!this.is("op", ")")) {
      this.skipTypes();
      const p = this.eat("id").value;
      let def = null;
      if (this.is("op", "=")) {
        this.next();
        def = this.expr();
      }
      params.push({ name: p, def });
      if (!this.is("op", ")")) this.eat("op", ",");
    }
    this.eat("op", ")");
    this.eat("op", "=>");
    return node("FuncDef", name, { name: name.value, params, body: this.bodyAfter() });
  }
  ifStmt() {
    const t = this.eat("kw", "if");
    const cond = this.expr();
    const then = this.block();
    let otherwise = null;
    const save = this.k;
    this.skipNl();
    if (this.is("kw", "else")) {
      this.next();
      if (this.is("kw", "if")) {
        const inner = this.ifStmt();
        otherwise = node("Block", inner, { body: [inner] });
      } else otherwise = this.block();
    } else this.k = save;
    return node("If", t, { cond, then, otherwise });
  }
  forStmt() {
    const t = this.eat("kw", "for");
    if (this.is("op", "[")) {
      this.next();
      const iv = this.eat("id").value;
      this.eat("op", ",");
      const v = this.eat("id").value;
      this.eat("op", "]");
      this.eat("kw", "in");
      return node("ForIn", t, { iv, v, src: this.expr(), body: this.block() });
    }
    if (this.is("kw", "in", 1)) {
      const v = this.eat("id").value;
      this.eat("kw", "in");
      return node("ForIn", t, { iv: null, v, src: this.expr(), body: this.block() });
    }
    const v = this.eat("id").value;
    this.eat("op", "=");
    const from = this.expr();
    this.eat("kw", "to");
    const to = this.expr();
    let step = null;
    if (this.is("kw", "by")) {
      this.next();
      step = this.expr();
    }
    return node("For", t, { v, from, to, step, body: this.block() });
  }
  whileStmt() {
    const t = this.eat("kw", "while");
    const cond = this.expr();
    return node("While", t, { cond, body: this.block() });
  }
  switchStmt() {
    const t = this.eat("kw", "switch");
    const subject = this.is("nl") ? null : this.expr();
    this.eat("nl");
    this.skipNl();
    this.eat("indent");
    const cases = [];
    while (!this.is("dedent") && !this.is("eof")) {
      let when = null;
      if (!this.is("op", "=>")) when = this.expr();
      this.eat("op", "=>");
      cases.push({ when, body: this.bodyAfter() });
      this.endStatement();
    }
    if (this.is("dedent")) this.next();
    return node("Switch", t, { subject, cases });
  }
  exprOrIf() {
    if (this.is("kw", "if")) return this.ifStmt();
    if (this.is("kw", "switch")) return this.switchStmt();
    if (this.is("kw", "for")) return this.forStmt();
    return this.expr();
  }
  // ---- expressions, lowest precedence first
  expr() {
    const cond = this.or();
    if (this.is("op", "?")) {
      const t = this.next();
      const a = this.expr();
      this.eat("op", ":");
      const b = this.expr();
      return node("Ternary", t, { cond, a, b });
    }
    return cond;
  }
  binary(next, ops) {
    let left = next();
    for (;;) {
      const t = this.peek();
      if ((t.type === "op" || t.type === "kw") && ops.includes(t.value)) {
        this.next();
        left = node("Bin", t, { op: t.value, left, right: next() });
      } else return left;
    }
  }
  or() {
    return this.binary(() => this.and(), ["or"]);
  }
  and() {
    return this.binary(() => this.eq(), ["and"]);
  }
  eq() {
    return this.binary(() => this.cmp(), ["==", "!="]);
  }
  cmp() {
    return this.binary(() => this.add(), ["<", ">", "<=", ">="]);
  }
  add() {
    return this.binary(() => this.mul(), ["+", "-"]);
  }
  mul() {
    return this.binary(() => this.unary(), ["*", "/", "%"]);
  }
  unary() {
    const t = this.peek();
    if ((t.type === "kw" && t.value === "not") || (t.type === "op" && (t.value === "-" || t.value === "+"))) {
      this.next();
      return node("Unary", t, { op: t.value, arg: this.unary() });
    }
    return this.postfix();
  }
  postfix() {
    let e = this.primary();
    for (;;) {
      // array.new<float>(...): the type in <> is skipped; only for these constructors, so a < b > (c) stays a comparison
      if (this.is("op", "<") && e.type === "Ident" && /^(array|matrix|map)\.new$/.test(e.name)) {
        const g = this.genericLen(0);
        if (g && this.is("op", "(", g)) {
          this.k += g;
          continue;
        }
      }
      if (this.is("op", "(")) {
        const t = this.next();
        if (e.type !== "Ident" && e.type !== "Member") throw new PineError("only a function name can be called", t.line, t.col);
        const args = [];
        while (!this.is("op", ")")) {
          if ((this.is("id") || this.is("kw", "type")) && this.is("op", "=", 1)) {
            const n = this.next().value;
            this.next();
            args.push({ name: n, value: this.expr() });
          } else args.push({ value: this.expr() });
          if (!this.is("op", ")")) this.eat("op", ",");
        }
        this.eat("op", ")");
        e = e.type === "Member" ? node("MethodCall", t, { target: e.target, method: e.fields.at(-1), via: e.fields.slice(0, -1), args }) : node("Call", t, { name: e.name, args });
      } else if (this.is("op", "[")) {
        const t = this.next();
        const index = this.expr();
        this.eat("op", "]");
        e = node("Index", t, { target: e, index });
      } else if (this.is("op", ".")) {
        // f(x).field, arr.get(0).price, f(x).method(): fields and methods of any value
        const t = this.next();
        const id = this.eat("id");
        e = node("Member", t, { target: e, fields: id.value.split(".") });
      } else return e;
    }
  }
  primary() {
    const t = this.next();
    if (t.type === "num") return node("Num", t, { value: t.value, ...(t.float ? { float: true } : {}) });
    if (t.type === "str") return node("Str", t, { value: t.value });
    if (t.type === "color") return node("Color", t, { value: t.value });
    if (t.type === "kw" && (t.value === "true" || t.value === "false")) return node("Bool", t, { value: t.value === "true" });
    if (t.type === "kw" && t.value === "if") {
      this.k--;
      return this.ifStmt();
    }
    if (t.type === "kw" && t.value === "switch") {
      this.k--;
      return this.switchStmt();
    }
    if (t.type === "id") return node("Ident", t, { name: t.value });
    if (t.type === "op" && t.value === "(") {
      const e = this.expr();
      this.eat("op", ")");
      return e;
    }
    if (t.type === "op" && t.value === "[") {
      const items = [];
      while (!this.is("op", "]")) {
        items.push(this.expr());
        if (!this.is("op", "]")) this.eat("op", ",");
      }
      this.eat("op", "]");
      return node("Tuple", t, { items });
    }
    const what = t.type === "nl" ? "the end of the line" : t.type === "eof" ? "the end of the script" : `"${t.value}"`;
    throw new PineError(`didn't expect ${what} here`, t.line, t.col);
  }
}

// ======================================================================= values
const NA = NaN;
// An object of one of the script's own types. Fields live in a Map, so a field name can only ever
// reach the type's own fields (never constructor, __proto__ or the like). Objects are references.
class UdtObj {
  constructor(type, fields) {
    this.type = type;
    this.fields = fields;
  }
}
// array<T>: a reference too; every array.* function works on .items.
class PineArray {
  constructor(items = []) {
    this.items = items;
  }
}
// A line, label, box, linefill or table the script made: a reference, kept until deleted (or pushed
// out by the max_*_count limit), and drawn as it stands when the run ends.
class Drawing {
  constructor(kind, props) {
    this.kind = kind;
    this.p = props;
    this.deleted = false;
  }
}
const isNa = (v) => v === undefined || v === null || (typeof v === "number" && Number.isNaN(v));
const truthy = (v) => (typeof v === "boolean" ? v : typeof v === "number" ? !Number.isNaN(v) && v !== 0 : !!v);
function hexColor(h) {
  const s = h.replace("#", "");
  const n = parseInt(s.slice(0, 6), 16),
    a = s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1;
  return rgba(n >> 16, (n >> 8) & 255, n & 255, a);
}
const rgba = (r, g, b, a = 1) => ({ r, g, b, a });
const isColor = (c) => c && typeof c === "object" && "r" in c && "a" in c;
export const cssColor = (c) => (isColor(c) ? (c.a >= 1 ? `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}` : `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${+c.a.toFixed(3)})`) : null);
// TradingView's named colours (v6). Version 5 scripts keep v5's red, teal and yellow.
const COLORS = {
  aqua: "#00BCD4", black: "#363A45", blue: "#2196F3", fuchsia: "#E040FB", gray: "#787B86", green: "#4CAF50", lime: "#00E676", maroon: "#880E4F",
  navy: "#311B92", olive: "#808000", orange: "#FF9800", purple: "#9C27B0", red: "#F23645", silver: "#B2B5BE", teal: "#089981", white: "#FFFFFF", yellow: "#FDD835",
};
const V5_COLORS = { "color.red": hexColor("#FF5252"), "color.teal": hexColor("#00897B"), "color.yellow": hexColor("#FFEB3B") };
let VERSION = 6;
const constOf = (nm) => (VERSION < 6 && V5_COLORS[nm]) || CONST[nm];

// Constants by their Pine names.
const CONST = {
  "math.pi": Math.PI, "math.e": Math.E, "math.phi": 1.618033988749895, "math.rphi": 0.618033988749895,
  "strategy.long": "long", "strategy.short": "short", "strategy.fixed": "fixed", "strategy.cash": "cash", "strategy.percent_of_equity": "percent_of_equity",
  "strategy.commission.percent": "percent", "strategy.commission.cash_per_contract": "cash_per_contract", "strategy.commission.cash_per_order": "cash_per_order",
  "strategy.direction.all": "all", "strategy.direction.long": "long", "strategy.direction.short": "short",
  "strategy.oca.none": "none", "strategy.oca.cancel": "cancel", "strategy.oca.reduce": "reduce",
  "dayofweek.sunday": 1, "dayofweek.monday": 2, "dayofweek.tuesday": 3, "dayofweek.wednesday": 4, "dayofweek.thursday": 5, "dayofweek.friday": 6, "dayofweek.saturday": 7,
};
for (const k of ["line", "linebr", "stepline", "stepline_diamond", "steplinebr", "histogram", "columns", "circles", "cross", "area", "areabr"]) CONST[`plot.style_${k}`] = k;
for (const c of ["NONE", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD", "CNY", "HKD", "SGD", "SEK", "NOK", "DKK", "PLN", "TRY", "ZAR", "MXN", "BRL", "INR", "KRW", "RUB", "BTC", "ETH", "USDT", "USDC"]) CONST[`currency.${c}`] = c;
for (const k of ["triangleup", "triangledown", "arrowup", "arrowdown", "labelup", "labeldown", "circle", "cross", "xcross", "diamond", "square", "flag"]) CONST[`shape.${k}`] = k;
for (const k of ["abovebar", "belowbar", "top", "bottom", "absolute"]) CONST[`location.${k}`] = k;
for (const k of ["auto", "tiny", "small", "normal", "large", "huge"]) CONST[`size.${k}`] = k;
for (const k of ["solid", "dotted", "dashed"]) CONST[`hline.style_${k}`] = k;
for (const k of ["all", "none", "data_window", "pane", "status_line", "price_scale"]) CONST[`display.${k}`] = k;
for (const k of ["none", "left", "right", "both"]) CONST[`extend.${k}`] = k;
for (const k of ["price", "percent", "volume", "inherit", "mintick"]) CONST[`format.${k}`] = k;
for (const k of ["left", "center", "right", "top", "bottom"]) CONST[`text.align_${k}`] = k;
for (const k of ["solid", "dotted", "dashed", "arrow_left", "arrow_right", "arrow_both"]) CONST[`line.style_${k}`] = k;
for (const k of ["none", "xcross", "cross", "triangleup", "triangledown", "flag", "circle", "arrowup", "arrowdown", "label_up", "label_down", "label_left", "label_right", "label_center", "square", "diamond", "text_outline"]) CONST[`label.style_${k}`] = k;
for (const k of ["bar_index", "bar_time"]) CONST[`xloc.${k}`] = k;
for (const k of ["price", "abovebar", "belowbar"]) CONST[`yloc.${k}`] = k;
for (const k of ["top_left", "top_center", "top_right", "middle_left", "middle_center", "middle_right", "bottom_left", "bottom_center", "bottom_right"]) CONST[`position.${k}`] = k;
for (const k of ["gaps_on", "gaps_off", "lookahead_on", "lookahead_off"]) CONST[`barmerge.${k}`] = k;
for (const k of ["all", "once_per_bar", "once_per_bar_close"]) CONST[`alert.freq_${k}`] = k;
for (const k of ["right", "left", "none"]) CONST[`scale.${k}`] = k;
for (const k of ["bold", "italic", "none"]) CONST[`text.format_${k}`] = k;
for (const k of ["default", "monospace"]) CONST[`font.family_${k}`] = k;
for (const [k, v] of Object.entries(COLORS)) CONST[`color.${k}`] = hexColor(v);
// A script's names are looked up in these tables, so they must not inherit Object's members.
Object.setPrototypeOf(CONST, null);
Object.setPrototypeOf(V5_COLORS, null);

// Built-in names that would only draw (labels, lines, boxes, tables, fills): accepted, skipped.
const SKIP_PREFIX = ["polyline.", "chart.point."];
CONST["order.ascending"] = "asc";
CONST["order.descending"] = "desc";
const SKIP_FUNCS = new Set(["fill", "bgcolor", "barcolor", "alertcondition", "alert", "log.info", "log.warning", "log.error", "plotarrow", "plotcandle", "plotbar", "max_bars_back"]);
const UNSUPPORTED_PREFIX = ["request.", "matrix.", "map.", "ticker.", "library"];
// Built-in namespaces: never a variable's name, so ta.ema() and the like skip the receiver lookup.
const NAMESPACES = new Set(["ta", "math", "str", "color", "input", "request", "strategy", "array", "matrix", "map", "line", "label", "box", "table", "linefill", "polyline", "chart", "syminfo", "timeframe", "barstate", "ticker", "runtime", "log", "session", "dayofweek", "order", "format", "size", "shape", "location", "position", "extend", "xloc", "yloc", "text", "font", "plot", "hline", "display", "currency", "alert", "earnings", "dividends", "splits", "adjustment", "barmerge", "scale"]);

// ======================================================================= the interpreter
// ======================================================================= Pine v3 and v4
// Older scripts, read as Pine v5 would write them: input(type=...) is input.<type>(), functions and
// values without their namespace get it (sma -> ta.sma, max -> math.max, tr -> ta.tr), transp= goes
// into the colour, strategy.entry's long= is its direction, and v3's bare colours are color.<name>.
// A variable the script declares keeps its name, and so does a function it defines (v4 lets a variable
// share a function's name: rsi = rsi(close, 14)).
const OLD_INPUT_TYPES = { "input.integer": "int", "input.float": "float", "input.bool": "bool", "input.string": "string", "input.source": "source", "input.resolution": "timeframe", "input.symbol": "symbol", "input.session": "session", "input.color": "color", "input.time": "time", integer: "int", float: "float", bool: "bool", string: "string", source: "source", resolution: "timeframe", symbol: "symbol", session: "session" };
const OLD_FUNCS = Object.fromEntries([
  ...["sma", "ema", "rma", "wma", "vwma", "hma", "swma", "alma", "linreg", "rsi", "macd", "stoch", "cci", "mfi", "wpr", "cmo", "tsi", "stdev", "variance", "dev", "tr", "atr", "bb", "bbw", "kc", "kcw", "highest", "lowest", "highestbars", "lowestbars", "change", "mom", "roc", "rising", "falling", "cum", "range", "median", "mode", "percentrank", "percentile_linear_interpolation", "percentile_nearest_rank", "correlation", "cross", "crossover", "crossunder", "barssince", "valuewhen", "pivothigh", "pivotlow", "supertrend", "dmi", "sar", "vwap", "cog"].map((f) => [f, `ta.${f}`]),
  ...["abs", "ceil", "floor", "round", "sqrt", "pow", "exp", "log", "log10", "sign", "sin", "cos", "tan", "asin", "acos", "atan", "todegrees", "toradians", "max", "min", "avg", "sum", "random"].map((f) => [f, `math.${f}`]),
  ["tostring", "str.tostring"],
  ["tonumber", "str.tonumber"],
  ["security", "request.security"],
  ["financial", "request.financial"],
  ["study", "indicator"],
  ["color", "color.new"],
]);
const OLD_VARS = { tr: "ta.tr", obv: "ta.obv", vwap: "ta.vwap", accdist: "ta.accdist", pvt: "ta.pvt", period: "timeframe.period", interval: "timeframe.multiplier", isintraday: "timeframe.isintraday", isdaily: "timeframe.isdaily", isweekly: "timeframe.isweekly", ismonthly: "timeframe.ismonthly", isdwm: "timeframe.isdwm", tickerid: "syminfo.tickerid" };
const OLD_COLORS = ["red", "green", "blue", "black", "white", "gray", "silver", "maroon", "purple", "fuchsia", "lime", "olive", "yellow", "navy", "teal", "aqua", "orange"];
// v3's bare plot and line styles, and its bar counter
const OLD_V3_NAMES = { n: "bar_index", line: "plot.style_line", linebr: "plot.style_linebr", stepline: "plot.style_stepline", histogram: "plot.style_histogram", cross: "plot.style_cross", area: "plot.style_area", columns: "plot.style_columns", circles: "plot.style_circles", solid: "hline.style_solid", dotted: "hline.style_dotted", dashed: "hline.style_dashed" };
// where each plot-like call takes its colour, for v4's transp=
const COLOR_ARG = { plot: 2, plotshape: 4, plotchar: 4, bgcolor: 0, fill: 2, barcolor: 0 };
function upgradeOld(ast, version) {
  // the names the script declares: variables (with parameters and loop counters), and functions
  const own = new Set(),
    ownFuncs = new Set();
  const collect = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(collect);
    if (n.type === "Decl") own.add(n.name);
    if (n.type === "TupleDecl") n.names.forEach((x) => own.add(typeof x === "string" ? x : x?.name));
    if (n.type === "FuncDef") {
      ownFuncs.add(n.name);
      (n.params || []).forEach((x) => own.add(x.name));
    }
    if (n.type === "For") own.add(n.v);
    if (n.type === "ForIn") [n.iv, n.v].forEach((x) => x && own.add(x));
    for (const v of Object.values(n)) if (v && typeof v === "object") collect(v);
  };
  collect(ast);
  const vars = { ...OLD_VARS };
  if (version <= 3) {
    for (const c of OLD_COLORS) vars[c] = `color.${c}`;
    Object.assign(vars, OLD_V3_NAMES);
  }
  const fix = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(fix);
    if (n.type === "Ident" && vars[n.name] && !own.has(n.name)) n.name = vars[n.name];
    // v4's label styles: label.style_labeldown is v5's label.style_label_down
    else if (n.type === "Ident" && /^label\.style_label(up|down|left|right|center)$/.test(n.name)) n.name = n.name.replace("style_label", "style_label_");
    // v3 and v4's offset(source, n) is source[n]
    if (n.type === "Call" && n.name === "offset" && !ownFuncs.has("offset") && n.args.length === 2) {
      Object.assign(n, { type: "Index", target: n.args[0].value, index: n.args[1].value });
      delete n.name;
      delete n.args;
    }
    if (n.type === "Call") {
      if (n.name === "input") {
        // input(defval, title, type, ...) or input(..., type=input.integer)
        let at = n.args.findIndex((a) => a.name === "type");
        if (at < 0) {
          const pos = n.args.map((a, k) => [a, k]).filter(([a]) => !a.name);
          const third = pos[2];
          if (third && third[0].value?.type === "Ident" && OLD_INPUT_TYPES[third[0].value.name]) at = third[1];
        }
        const kind = at >= 0 && n.args[at].value?.type === "Ident" ? OLD_INPUT_TYPES[n.args[at].value.name] : null;
        if (at >= 0) n.args.splice(at, 1);
        if (kind) n.name = `input.${kind}`;
      } else if (OLD_FUNCS[n.name] && !ownFuncs.has(n.name)) n.name = OLD_FUNCS[n.name];
      if (n.name === "strategy.entry" || n.name === "strategy.order") for (const a of n.args) if (a.name === "long") a.name = "direction";
      const ci = COLOR_ARG[n.name];
      const ti = n.args.findIndex((a) => a.name === "transp");
      if (ci !== undefined && ti >= 0) {
        const transp = n.args[ti].value;
        n.args.splice(ti, 1);
        const named = n.args.find((a) => a.name === "color");
        const slot = named || n.args.filter((a) => !a.name)[ci];
        if (slot) slot.value = node("Call", slot.value, { name: "color.new", args: [{ value: slot.value }, { value: transp }] });
      }
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") fix(v);
  };
  fix(ast);
}

export function compilePine(src) {
  NODE_ID = 0;
  VERSION = Number(/\/\/\s*@version\s*=\s*(\d+)/.exec(src)?.[1] || 6);
  const ast = new Parser(lex(src)).program();
  if (VERSION <= 4) upgradeOld(ast, VERSION);
  // top-level names set once to a fixed value, and never set again: group names, versions, options
  const reset = new Set();
  const sets = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(sets);
    if (n.type === "Assign") reset.add(n.name);
    if (n.type === "TupleDecl" && n.reassign) n.names.forEach((x) => reset.add(x));
    for (const v of Object.values(n)) if (v && typeof v === "object") sets(v);
  };
  sets(ast);
  STATIC_NAMES = new Map();
  for (const st of ast.body || []) {
    if (st.type !== "Decl" || reset.has(st.name) || STATIC_NAMES.has(st.name)) continue;
    const v = staticVal(st.value);
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || isColor(v)) STATIC_NAMES.set(st.name, v);
  }
  const meta = { kind: null, title: "Script", shorttitle: null, overlay: false, opts: {} };
  const inputs = [],
    plots = [],
    hlines = [],
    warnings = new Set();
  const funcs = new Set();
  const types = new Map();
  const drawsKinds = new Set();
  // Static pass: the declaration, inputs, plots and levels, read from the code before any run.
  const walk = (n, inFunc) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, inFunc));
    if (n.type === "FuncDef") {
      funcs.add(n.name);
      return walk(n.body, true);
    }
    if (n.type === "TypeDef") {
      if (types.has(n.name)) throw new PineError(`the type ${n.name} is declared twice`, n.line);
      types.set(n.name, n);
    }
    if (n.type === "Call" && /^(line|label|box|linefill|table)\.new$/.test(n.name)) drawsKinds.add(n.name.split(".")[0]);
    if (n.type === "Call") {
      const a = (k, name) => argNode(n, k, name);
      if (n.name === "indicator" || n.name === "strategy" || n.name === "study") {
        if (meta.kind) throw new PineError("a script declares indicator() or strategy() once", n.line);
        meta.kind = n.name === "strategy" ? "strategy" : "indicator";
        meta.title = staticVal(a(0, "title")) ?? "Script";
        meta.shorttitle = staticVal(a(1, "shorttitle")) ?? null;
        meta.overlay = !!staticVal(a(2, "overlay"));
        for (const x of n.args) if (x.name) meta.opts[x.name] = staticVal(x.value);
      } else if (n.name === "library") throw new PineError("libraries aren't supported here; use indicator() or strategy()", n.line);
      else if (/^input(\.|$)/.test(n.name)) {
        if (inFunc) throw new PineError("inputs must be at the top level of the script", n.line);
        inputs.push(inputSpec(n, inputs.length));
      } else if (["plot", "plotshape", "plotchar"].includes(n.name)) {
        if (inFunc) throw new PineError(`${n.name}() must be at the top level of the script`, n.line);
        plots.push(plotSpec(n, plots.length));
      } else if (n.name === "hline") {
        const price = staticVal(a(0, "price"));
        if (Number.isFinite(price)) {
          const color = staticVal(a(2, "color"));
          hlines.push({ price, title: staticVal(a(1, "title")) || "", color: isColor(color) ? cssColor(color) : null, style: staticVal(a(3, "linestyle")) || "dashed", width: staticVal(a(4, "linewidth")) || 1 });
        }
      }
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v, inFunc);
  };
  try {
    walk(ast.body, false);
  } finally {
    STATIC_NAMES = null;
  }
  if (!meta.kind) throw new PineError("the script needs indicator(\"Name\") or strategy(\"Name\") at the top");
  const sourceInputs = inputs.filter((x) => x.type === "source");
  sourceInputs.forEach((x, k) => (x.key = k ? `source${k + 1}` : "source"));
  return { ast, meta, inputs, plots, hlines, warnings, funcs, types, drawsKinds: [...drawsKinds], version: VERSION };
}

function argNode(call, pos, name) {
  const named = call.args.find((a) => a.name === name);
  if (named) return named.value;
  const positional = call.args.filter((a) => !a.name);
  return positional[pos]?.value;
}
// A value known before running: literals, named colours and constants, color.new on those.
let STATIC_NAMES = null; // while compiling: top-level names set once to a fixed value
function staticVal(n) {
  if (!n) return undefined;
  if (n.type === "Ident" && STATIC_NAMES?.has(n.name)) return STATIC_NAMES.get(n.name);
  switch (n.type) {
    case "Num":
    case "Str":
    case "Bool":
    case "Color":
      return n.value;
    case "Unary":
      if (n.op === "-") {
        const v = staticVal(n.arg);
        return typeof v === "number" ? -v : undefined;
      }
      return undefined;
    case "Ident":
      if (n.name in CONST) return constOf(n.name);
      if (["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "hlcc4"].includes(n.name)) return { source: n.name };
      if (n.name === "na") return NA;
      return undefined;
    case "Call":
      if (n.name === "color.new") {
        const c = staticVal(argNode(n, 0, "color")),
          t = staticVal(argNode(n, 1, "transp"));
        return isColor(c) && typeof t === "number" ? { ...c, a: c.a * (1 - t / 100) } : undefined;
      }
      if (n.name === "color.rgb") {
        const [r, g, b, t = 0] = [0, 1, 2, 3].map((k) => staticVal(argNode(n, k, ["red", "green", "blue", "transp"][k])));
        return [r, g, b].every((x) => typeof x === "number") ? rgba(r, g, b, 1 - (t || 0) / 100) : undefined;
      }
      return undefined;
    case "Bin": {
      const a = staticVal(n.left),
        b = staticVal(n.right);
      if (typeof a !== "number" || typeof b !== "number") return undefined;
      return { "+": a + b, "-": a - b, "*": a * b, "/": a / b }[n.op];
    }
    default:
      return undefined;
  }
}
const SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "hlcc4"];
function inputSpec(n, k) {
  const kind = n.name === "input" ? null : n.name.slice(6);
  const defNode = argNode(n, 0, "defval");
  const def = staticVal(defNode);
  const written = defNode?.type === "Unary" ? defNode.arg : defNode;
  const title = staticVal(argNode(n, 1, "title"));
  const named = (nm) => staticVal(n.args.find((a) => a.name === nm)?.value);
  const optionsNode = n.args.find((a) => a.name === "options")?.value;
  const options = optionsNode?.type === "Tuple" ? optionsNode.items.map(staticVal) : null;
  const minval = named("minval"),
    maxval = named("maxval"),
    step = named("step");
  const label = typeof title === "string" && title ? title : `Input ${k + 1}`;
  const key = `in${k + 1}`;
  const t = kind || (def && def.source ? "source" : typeof def === "boolean" ? "bool" : isColor(def) ? "color" : typeof def === "string" ? "string" : Number.isInteger(def) && !written?.float ? "int" : "float");
  // how the Settings dialog lays it out: TradingView's group headers, inline rows and info tooltips
  const str = (v) => (typeof v === "string" && v ? v.slice(0, 500) : undefined);
  const spec = { node: n.id, key, label, kind: t, def, line: n.line, group: str(named("group")), inline: str(named("inline")), tooltip: str(named("tooltip")) };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if (t === "source") return { ...spec, type: "source", default: def?.source && SOURCES.includes(def.source) ? def.source : "close" };
  if (t === "bool") return { ...spec, type: "bool", default: def !== false };
  if ((t === "int" || t === "float" || t === "string") && options?.length && options.every((o) => o !== undefined))
    return { ...spec, type: "select", options: options.map(String), default: String(def ?? options[0]) };
  if (t === "int") return { ...spec, type: "int", default: Number.isInteger(def) ? def : Math.round(Number(def) || 0), min: num(minval), max: num(maxval), step: num(step) };
  if (t === "float" || t === "price") return { ...spec, type: "float", default: Number.isFinite(def) ? def : 0, min: num(minval), max: num(maxval), step: num(step) };
  if (t === "time") return { ...spec, type: "time", default: Number.isFinite(def) ? Math.round(def / 1000) : 0 };
  // a default the script works out (input.color(base), input.string(a + b)) is worked out at run time
  // until the Settings dialog saves a value
  if (t === "color") return { ...spec, type: "color", default: isColor(def) ? cssColor(def) : "#2962ff", ...(isColor(def) ? {} : { dynamic: true }) };
  const text = typeof def === "string" ? {} : { dynamic: true };
  if (t === "string" || t === "symbol" || t === "session") return { ...spec, type: "text", default: typeof def === "string" ? def : "", ...text };
  if (t === "text_area") return { ...spec, type: "textarea", default: typeof def === "string" ? def : "", ...text };
  if (t === "timeframe") return { ...spec, type: "timeframe", default: typeof def === "string" ? def : "", ...text };
  // anything else keeps the script's value
  return { ...spec, type: null };
}
// A colour the Settings dialog saved (#rrggbb, #rrggbbaa or rgba()) as a Pine colour.
function colorFromCss(v) {
  const s = String(v ?? "").trim();
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (hex) return hexColor(s);
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  return m ? rgba(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4])))) : NA;
}
function plotSpec(n, k) {
  const fn = n.name;
  const title = staticVal(argNode(n, 1, "title"));
  const colorNode = argNode(n, fn === "plot" ? 2 : 4, "color");
  const color = staticVal(colorNode);
  const style = staticVal(n.args.find((a) => a.name === "style")?.value ?? (fn === "plot" ? argNode(n, 4, "style") : undefined));
  const width = staticVal(n.args.find((a) => a.name === "linewidth")?.value ?? (fn === "plot" ? argNode(n, 3, "linewidth") : undefined));
  const display = staticVal(n.args.find((a) => a.name === "display")?.value);
  // a plotshape's or plotchar's place and shape, when the script names them outright
  const location = fn === "plot" ? undefined : staticVal(argNode(n, 3, "location"));
  const shape = fn === "plotshape" ? staticVal(argNode(n, 2, "style")) : fn === "plotchar" ? "char" : undefined;
  return { node: n.id, fn, key: `p${k + 1}`, location, shape, title: typeof title === "string" && title ? title : k ? `Plot ${k + 1}` : "Plot", color: isColor(color) ? cssColor(color) : colorNode ? null : "#2962ff", dynamicColor: !!colorNode && color === undefined, style: style || "line", width: Number.isFinite(width) ? width : 1, hidden: display === "none" };
}

// ---------- running ----------
// params: input values by key. ctx: { symbol, tf, mintick }. Returns plot arrays, colours, markers,
// warnings and, for a strategy, its trades and equity.
// Loops count toward one budget per run. Each loop also stops at 100,000 turns, but loops inside
// loops multiply, and a script that runs too long freezes the page.
const RUN_LIMIT_MS = 10000;
export function runPine(compiled, bars, params = {}, ctx = {}) {
  const { ast, meta, inputs, plots } = compiled;
  const n = bars.length;
  VERSION = compiled.version || 6;
  const R = new Runtime(compiled, bars, params, ctx);
  R.work = 0;
  R.deadline = Date.now() + RUN_LIMIT_MS;
  for (let i = 0; i < n; i++) {
    R.i = i;
    R.strat?.beforeBar(i);
    try {
      R.execBlock(ast.body, R.global, "");
    } catch (e) {
      if (e instanceof PineError) throw e;
      if (e && e.flow) throw new PineError(`${e.flow} outside a loop`, e.line);
      throw new PineError(e.message || String(e), R.line);
    }
    R.commit(i);
    R.strat?.afterBar(i);
  }
  const out = { plots: {}, colors: {}, markers: R.markers, warnings: [...R.warnings], meta, inputs, plotSpecs: plots };
  for (const p of plots) {
    out.plots[p.key] = R.plotVals[p.key] || new Array(n).fill(NaN);
    if (R.plotColors[p.key]) out.colors[p.key] = R.plotColors[p.key];
  }
  if (R.strat) out.strategy = R.strat.result();
  const drawings = R.drawingsOut();
  if (drawings) out.drawings = drawings;
  return out;
}

class Flow {
  constructor(flow, line) {
    this.flow = flow;
    this.line = line;
  }
}

class Runtime {
  constructor(compiled, bars, params, ctx) {
    this.c = compiled;
    this.bars = bars;
    this.n = bars.length;
    this.ctx = ctx;
    this.params = params;
    this.slots = new Map();
    this.state = new Map();
    this.nodeHist = new Map();
    this.global = { vars: new Map(), parent: null };
    this.funcs = new Map();
    this.types = compiled.types || new Map();
    this.drawn = { line: [], label: [], box: [], linefill: [], table: [] };
    const limit = (k) => Math.min(500, Math.max(1, Math.round(Number(compiled.meta.opts?.[k]) || 50)));
    this.drawMax = { line: limit("max_lines_count"), label: limit("max_labels_count"), box: limit("max_boxes_count"), linefill: 500, table: 100 };
    this.plotVals = {};
    this.plotColors = {};
    this.markers = [];
    this.warnings = compiled.warnings;
    this.line = 0;
    this.depth = 0;
    this.inputByNode = new Map(compiled.inputs.map((x) => [x.node, x]));
    this.plotByNode = new Map(compiled.plots.map((x) => [x.node, x]));
    this.mintick = ctx.mintick || guessMintick(bars);
    this.pre = precompute(bars);
    // the Settings dialog's Properties (ctx.strategy) override the script's own strategy() arguments
    if (compiled.meta.kind === "strategy") this.strat = new Strategy({ ...compiled.meta.opts, ...(ctx.strategy || {}) }, bars, this.mintick, ctx);
  }
  // One loop turn of the run's time budget; checking the clock every 4096 turns keeps it cheap.
  spend(line) {
    if ((++this.work & 4095) === 0 && Date.now() > this.deadline)
      throw new PineError(`this script ran for more than ${RUN_LIMIT_MS / 1000} seconds, so it was stopped`, line);
  }
  // ---- variables: one slot per declaration and call path, with a value per bar for []
  slot(key, name, persistent) {
    let s = this.slots.get(key);
    if (!s) this.slots.set(key, (s = { name, value: NA, hist: new Array(this.n), persistent, bar: -1, init: false }));
    return s;
  }
  commit(i) {
    for (const s of this.slots.values()) s.hist[i] = s.persistent || s.bar === i ? s.value : NA;
  }
  lookup(scope, name) {
    for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
    return null;
  }
  execBlock(body, scope, path) {
    let last;
    for (const st of body) last = this.exec(st, scope, path);
    return last;
  }
  exec(st, scope, path) {
    this.line = st.line;
    switch (st.type) {
      case "Decl": {
        const s = this.slot(`${path}|${st.id}`, st.name, st.persistent);
        if (!st.persistent || !s.init) {
          s.value = this.eval(st.value, scope, path);
          s.init = true;
        }
        s.bar = this.i;
        scope.vars.set(st.name, s);
        return s.value;
      }
      case "TupleDecl": {
        const v = this.eval(st.value, scope, path);
        if (!Array.isArray(v)) throw new PineError("the right side doesn't return several values", st.line);
        st.names.forEach((nm, k) => {
          if (nm === "_") return;
          if (st.reassign) {
            const s = this.lookup(scope, nm);
            if (!s) throw new PineError(`"${nm}" isn't declared yet; use = to declare it`, st.line);
            s.value = v[k];
            s.bar = this.i;
          } else {
            const s = this.slot(`${path}|${st.id}|${k}`, nm, false);
            s.value = v[k];
            s.bar = this.i;
            scope.vars.set(nm, s);
          }
        });
        return v;
      }
      case "Assign": {
        const s = this.lookup(scope, st.name);
        if (!s && st.name.includes(".")) return this.setField(st, scope, path);
        if (!s) throw new PineError(`"${st.name}" isn't declared yet; use = to declare it first`, st.line);
        const v = this.eval(st.value, scope, path);
        s.value = st.op === ":=" ? v : arith(st.op[0], s.value, v);
        s.bar = this.i;
        return s.value;
      }
      case "FuncDef":
        this.funcs.set(st.name, st);
        return NA;
      case "TypeDef":
        return NA;
      case "ExprStmt":
        return this.eval(st.expr, scope, path);
      case "Break":
        throw new Flow("break", st.line);
      case "Continue":
        throw new Flow("continue", st.line);
      default:
        return this.eval(st, scope, path);
    }
  }
  eval(e, scope, path) {
    switch (e.type) {
      case "Num":
      case "Str":
      case "Bool":
      case "Color":
        return e.value;
      case "Tuple":
        return e.items.map((x) => this.eval(x, scope, path));
      case "Ident":
        return this.ident(e, scope, path);
      case "Unary": {
        const v = this.eval(e.arg, scope, path);
        if (e.op === "not") return !truthy(v);
        return e.op === "-" ? -v : +v;
      }
      case "Bin": {
        if (e.op === "and") return truthy(this.eval(e.left, scope, path)) && truthy(this.eval(e.right, scope, path));
        if (e.op === "or") return truthy(this.eval(e.left, scope, path)) || truthy(this.eval(e.right, scope, path));
        const a = this.eval(e.left, scope, path),
          b = this.eval(e.right, scope, path);
        switch (e.op) {
          case "==":
            return isColor(a) && isColor(b) ? cssColor(a) === cssColor(b) : a === b;
          case "!=":
            return isColor(a) && isColor(b) ? cssColor(a) !== cssColor(b) : !(a === b) && !(isNa(a) && isNa(b));
          case "<":
            return a < b;
          case ">":
            return a > b;
          case "<=":
            return a <= b;
          case ">=":
            return a >= b;
          default:
            return arith(e.op, a, b);
        }
      }
      case "Ternary":
        return truthy(this.eval(e.cond, scope, path)) ? this.eval(e.a, scope, path) : this.eval(e.b, scope, path);
      case "Index":
        return this.index(e, scope, path);
      case "Call":
        return this.call(e, scope, path);
      case "If": {
        if (truthy(this.eval(e.cond, scope, path))) return this.execBlock(e.then.body, { vars: new Map(), parent: scope }, path);
        if (e.otherwise) return this.execBlock(e.otherwise.body, { vars: new Map(), parent: scope }, path);
        return NA;
      }
      case "For": {
        const from = this.eval(e.from, scope, path),
          to = this.eval(e.to, scope, path);
        if (isNa(from) || isNa(to)) return NA;
        let step = e.step ? Math.abs(this.eval(e.step, scope, path)) : 1;
        if (!(step > 0)) step = 1;
        const dir = to >= from ? 1 : -1;
        let last = NA,
          guard = 0;
        const inner = { vars: new Map(), parent: scope };
        const iv = { name: e.v, value: from, hist: [], persistent: false, bar: this.i };
        inner.vars.set(e.v, iv);
        for (let v = from; dir > 0 ? v <= to : v >= to; v += dir * step) {
          if (++guard > 100000) throw new PineError("this loop ran more than 100,000 times", e.line);
          this.spend(e.line);
          iv.value = v;
          try {
            last = this.execBlock(e.body.body, { vars: new Map(), parent: inner }, path);
          } catch (f) {
            if (f instanceof Flow && f.flow === "break") break;
            if (f instanceof Flow && f.flow === "continue") continue;
            throw f;
          }
        }
        return last;
      }
      case "ForIn": {
        const arr = this.eval(e.src, scope, path);
        if (isNa(arr)) return NA;
        if (!(arr instanceof PineArray)) throw new PineError("for…in goes over an array", e.line);
        let last = NA;
        const inner = { vars: new Map(), parent: scope };
        const xv = { name: e.v, value: NA, hist: [], persistent: false, bar: this.i };
        const iv = e.iv ? { name: e.iv, value: 0, hist: [], persistent: false, bar: this.i } : null;
        inner.vars.set(e.v, xv);
        if (iv) inner.vars.set(e.iv, iv);
        for (let k = 0; k < arr.items.length; k++) {
          if (k >= 100000) throw new PineError("this loop ran more than 100,000 times", e.line);
          this.spend(e.line);
          xv.value = arr.items[k];
          if (iv) iv.value = k;
          try {
            last = this.execBlock(e.body.body, { vars: new Map(), parent: inner }, path);
          } catch (f) {
            if (f instanceof Flow && f.flow === "break") break;
            if (f instanceof Flow && f.flow === "continue") continue;
            throw f;
          }
        }
        return last;
      }
      case "Member":
        return this.fieldOf(this.eval(e.target, scope, path), e.fields, e.line);
      case "MethodCall":
        return this.method(this.fieldOf(this.eval(e.target, scope, path), e.via, e.line), e.method, e, scope, path);
      case "While": {
        let last = NA,
          guard = 0;
        while (truthy(this.eval(e.cond, scope, path))) {
          if (++guard > 100000) throw new PineError("this loop ran more than 100,000 times", e.line);
          this.spend(e.line);
          try {
            last = this.execBlock(e.body.body, { vars: new Map(), parent: scope }, path);
          } catch (f) {
            if (f instanceof Flow && f.flow === "break") break;
            if (f instanceof Flow && f.flow === "continue") continue;
            throw f;
          }
        }
        return last;
      }
      case "Switch": {
        const subj = e.subject ? this.eval(e.subject, scope, path) : undefined;
        for (const c of e.cases) {
          const hit = !c.when || (e.subject ? this.eval(c.when, scope, path) === subj : truthy(this.eval(c.when, scope, path)));
          if (hit) return this.execBlock(c.body.body, { vars: new Map(), parent: scope }, path);
        }
        return NA;
      }
      default:
        throw new PineError(`can't run "${e.type}" here`, e.line);
    }
  }
  // Built-in series at bar i (bar_index, close...), the script's variables, constants.
  ident(e, scope, path) {
    const nm = e.name;
    const s = this.lookup(scope, nm);
    if (s) return s.value;
    // p.lvl, zone.box.left: fields of a variable holding one of the script's objects
    const dot = nm.indexOf(".");
    if (dot > 0) {
      // color.red, size.small, timeframe.multiplier: the built-in, even when the script has a variable called color,
      // size or timeframe (TradingView's way)
      if (NAMESPACES.has(nm.slice(0, dot))) {
        if (nm in CONST) return constOf(nm);
        const v = this.series(nm, this.i);
        if (v !== undefined) return v;
      }
      const base = this.lookup(scope, nm.slice(0, dot));
      if (base) return this.fieldOf(base.value, nm.slice(dot + 1).split("."), e.line);
    }
    const v = this.series(nm, this.i);
    if (v !== undefined) return v;
    if (nm in CONST) return constOf(nm);
    if (nm === "na") return NA;
    if (nm.startsWith("strategy.")) {
      if (!this.strat) throw new PineError(`${nm} is only for strategy() scripts`, e.line);
      return this.strat.get(nm.slice(9));
    }
    if (this.funcs.has(nm) || BUILTINS[nm]) throw new PineError(`${nm} is a function; call it with ()`, e.line);
    throw new PineError(`"${nm}" isn't declared`, e.line);
  }
  series(nm, i) {
    const b = this.bars[i];
    if (!b) return NA;
    switch (nm) {
      case "open":
      case "high":
      case "low":
      case "close":
        return b[nm];
      case "volume":
        return b.volume ?? NA;
      case "hl2":
        return (b.high + b.low) / 2;
      case "hlc3":
        return (b.high + b.low + b.close) / 3;
      case "ohlc4":
        return (b.open + b.high + b.low + b.close) / 4;
      case "hlcc4":
        return (b.high + b.low + 2 * b.close) / 4;
      case "time":
      case "time_tradingday":
        return b.time * 1000;
      case "time_close":
        return (this.bars[i + 1]?.time ?? b.time + (i ? b.time - this.bars[i - 1].time : 86400)) * 1000;
      case "timenow":
        return Date.now();
      case "bar_index":
        return i;
      case "last_bar_index":
        return this.n - 1;
      case "last_bar_time":
        return this.bars[this.n - 1].time * 1000;
      case "barstate.isfirst":
        return i === 0;
      case "line.all":
      case "label.all":
      case "box.all":
      case "linefill.all":
      case "table.all":
        return new PineArray([...this.drawn[nm.split(".")[0]]]);
      case "barstate.islast":
      case "barstate.isrealtime":
      case "barstate.islastconfirmedhistory":
        return i === this.n - 1;
      case "barstate.ishistory":
        return i < this.n - 1;
      case "barstate.isconfirmed":
      case "barstate.isnew":
        return true;
      case "ta.tr":
        return this.pre.tr[i];
      case "ta.obv":
        return this.pre.obv[i];
      case "ta.vwap":
        return this.pre.vwap[i];
      case "ta.accdist":
        return this.pre.accdist[i];
      case "ta.pvt":
        return this.pre.pvt[i];
      case "syminfo.ticker":
      case "syminfo.tickerid":
      case "syminfo.root":
        return String(this.ctx.symbol || "").split(":").pop();
      case "syminfo.prefix":
        return String(this.ctx.symbol || "").split(":")[0];
      case "syminfo.mintick":
        return this.mintick;
      case "syminfo.pointvalue":
        return 1;
      case "syminfo.currency":
        return "USD";
      case "syminfo.timezone":
        return "Etc/UTC";
      case "syminfo.type":
        return /BINANCE|COINBASE|KRAKEN/.test(String(this.ctx.symbol)) ? "crypto" : "stock";
      // no long names here: the ticker stands in
      case "syminfo.description":
        return String(this.ctx.symbol || "").split(":").pop();
      // TradingView's default chart colours for the page's theme
      case "chart.bg_color":
        return hexColor(this.ctx.theme === "light" ? "#FFFFFF" : "#131722");
      case "chart.fg_color":
        return hexColor(this.ctx.theme === "light" ? "#131722" : "#D1D4DC");
      case "timeframe.period":
        return pineTf(this.ctx.tf);
      case "timeframe.multiplier":
        return parseInt(this.ctx.tf, 10) || 1;
      case "timeframe.isintraday":
        return /[smh]$/.test(this.ctx.tf || "");
      case "timeframe.isseconds":
        return /s$/.test(this.ctx.tf || "");
      case "timeframe.isminutes":
        return /m$/.test(this.ctx.tf || "");
      case "timeframe.isdaily":
        return /D$/.test(this.ctx.tf || "");
      case "timeframe.isweekly":
        return /W$/.test(this.ctx.tf || "");
      case "timeframe.ismonthly":
        return /M$/.test(this.ctx.tf || "");
      case "timeframe.isdwm":
        return /[DWM]$/.test(this.ctx.tf || "");
      case "year":
      case "month":
      case "dayofmonth":
      case "dayofweek":
      case "hour":
      case "minute":
      case "second":
      case "weekofyear":
        return datePart(nm, b.time * 1000);
      default:
        return undefined;
    }
  }
  // x[n]: a variable's value n bars ago, or any expression's as it was evaluated then.
  index(e, scope, path) {
    const off = this.eval(e.index, scope, path);
    if (isNa(off)) return NA;
    const k = Math.round(off);
    if (k < 0) throw new PineError("history can't look forward (negative [])", e.line);
    const at = this.i - k;
    if (e.target.type === "Ident") {
      const s = this.lookup(scope, e.target.name);
      if (s) return k === 0 ? s.value : at >= 0 ? s.hist[at] ?? NA : NA;
      const v = this.series(e.target.name, at);
      if (v !== undefined) return at >= 0 ? v : NA;
    }
    const key = `${path}|${e.id}`;
    let h = this.nodeHist.get(key);
    if (!h) this.nodeHist.set(key, (h = new Array(this.n)));
    const cur = this.eval(e.target, scope, path);
    h[this.i] = cur;
    if (k === 0) return cur;
    return at >= 0 ? h[at] ?? NA : NA;
  }
  // The value at a chain of fields; na anywhere along it gives na.
  fieldOf(obj, names, line) {
    let v = obj;
    for (const f of names) {
      if (isNa(v)) return NA;
      if (!(v instanceof UdtObj)) throw new PineError(`"${f}" isn't a field of this value`, line);
      if (!v.fields.has(f)) throw new PineError(`"${f}" isn't a field of ${v.type}`, line);
      v = v.fields.get(f);
    }
    return v;
  }
  setField(st, scope, path) {
    const parts = st.name.split(".");
    const base = this.lookup(scope, parts[0]);
    if (!base) throw new PineError(`"${parts[0]}" isn't declared yet`, st.line);
    const obj = this.fieldOf(base.value, parts.slice(1, -1), st.line);
    const f = parts.at(-1);
    if (isNa(obj)) throw new PineError(`can't set "${f}": the object is na`, st.line);
    if (!(obj instanceof UdtObj) || !obj.fields.has(f)) throw new PineError(`"${f}" isn't a field of ${obj instanceof UdtObj ? obj.type : "this value"}`, st.line);
    const v = this.eval(st.value, scope, path);
    const nv = st.op === ":=" ? v : arith(st.op[0], obj.fields.get(f), v);
    obj.fields.set(f, nv);
    return nv;
  }
  // Type.new(...): fields by position or name; the rest take their default, else na.
  construct(type, e, scope, path) {
    const positional = e.args.filter((a) => !a.name);
    if (positional.length > type.fields.length) throw new PineError(`${type.name}.new() got too many arguments`, e.line);
    for (const a of e.args) if (a.name && !type.fields.some((f) => f.name === a.name)) throw new PineError(`${type.name} has no field called "${a.name}"`, e.line);
    const fields = new Map();
    type.fields.forEach((f, k) => {
      const named = e.args.find((a) => a.name === f.name);
      const src = named ? named.value : positional[k]?.value;
      fields.set(f.name, src ? this.eval(src, scope, path) : f.def ? this.eval(f.def, this.global, "") : NA);
    });
    return new UdtObj(type.name, fields);
  }
  // x.f(...) on an array (or other built-in object): the built-in f with x as its first argument.
  methodNs(recv) {
    return recv instanceof PineArray ? "array" : recv instanceof Drawing ? recv.kind : null;
  }
  method(recv, m, e, scope, path) {
    if (isNa(recv)) return NA;
    const ns = this.methodNs(recv);
    if (!ns) throw new PineError(recv instanceof UdtObj ? `methods of ${recv.type} aren't supported here yet` : `.${m}() isn't a method this app knows`, e.line);
    const def = BUILTINS[`${ns}.${m}`];
    if (!def) throw new PineError(`${ns}.${m}() isn't a function this app knows`, e.line);
    const vals = this.args(def.p, e, scope, path, [recv]);
    return def.f.call(this, vals, null, e, `${path}|${e.id}`);
  }
  call(e, scope, path) {
    const nm = e.name;
    this.line = e.line;
    const user = this.funcs.get(nm);
    if (user) return this.callUser(user, e, scope, path);
    if (nm === "indicator" || nm === "strategy" || nm === "study") return NA;
    // worked out once per call site: could this name be Type.new() or a method on a variable?
    if (e.objCall === undefined) e.objCall = nm.lastIndexOf(".") > 0 && !NAMESPACES.has(nm.slice(0, nm.indexOf(".")));
    if (e.objCall) {
      const dot = nm.lastIndexOf(".");
      const head = nm.slice(0, dot),
        m = nm.slice(dot + 1);
      const type = this.types.get(head);
      if (type && m === "new") return this.construct(type, e, scope, path);
      if (type && m === "copy") {
        const o = e.args[0] ? this.eval(e.args[0].value, scope, path) : NA;
        return o instanceof UdtObj ? new UdtObj(o.type, new Map(o.fields)) : NA;
      }
      if (type) throw new PineError(`${nm}() isn't a function this app knows`, e.line);
      // arr.push(x), zone.box.delete(): a method on a variable holding an object
      const parts = head.split(".");
      const base = this.lookup(scope, parts[0]);
      if (base) {
        const recv = this.fieldOf(base.value, parts.slice(1), e.line);
        if (isNa(recv) || recv instanceof UdtObj || this.methodNs(recv)) return this.method(recv, m, e, scope, path);
      }
    }
    if (nm.startsWith("input")) return this.input(e, scope, path);
    if (SKIP_FUNCS.has(nm) || SKIP_PREFIX.some((p) => nm.startsWith(p))) {
      if (!["alertcondition", "alert", "max_bars_back"].includes(nm) && !nm.startsWith("log.")) this.warnings.add(SKIP_NOTE(nm));
      for (const a of e.args) this.eval(a.value, scope, path); // still evaluate, for any history inside
      return NA;
    }
    if (UNSUPPORTED_PREFIX.some((p) => nm.startsWith(p))) throw new PineError(`${nm}() isn't supported here yet`, e.line);
    const def = BUILTINS[nm];
    if (!def) throw new PineError(`${nm}() isn't a function this app knows`, e.line);
    const vals = this.args(def.p, e, scope, path);
    const key = `${path}|${e.id}`;
    const st = def.s ? this.state.get(key) || this.state.set(key, {}).get(key) : null;
    return def.f.call(this, vals, st, e, key);
  }
  args(params, e, scope, path, pre = []) {
    const out = {};
    let pos = 0;
    for (const v of pre) out[params ? params[pos++] : pos++] = v;
    for (const a of e.args) {
      if (a.name) {
        if (params && !params.includes(a.name) && !params.includes("...")) throw new PineError(`${e.name || e.method}() has no argument called "${a.name}"`, e.line);
        out[a.name] = this.eval(a.value, scope, path);
      } else {
        const p = params ? params[pos] : pos;
        if (params && p === "...") {
          (out._rest ||= []).push(this.eval(a.value, scope, path));
          continue;
        }
        if (params && p === undefined) throw new PineError(`${e.name || e.method}() got too many arguments`, e.line);
        out[p] = this.eval(a.value, scope, path);
        pos++;
      }
    }
    return out;
  }
  callUser(fn, e, scope, path) {
    const sub = `${path}/${e.id}`;
    const fs = { vars: new Map(), parent: this.global };
    const positional = e.args.filter((a) => !a.name);
    fn.params.forEach((p, k) => {
      const named = e.args.find((a) => a.name === p.name);
      const src = named ? named.value : positional[k]?.value;
      const v = src ? this.eval(src, scope, path) : p.def ? this.eval(p.def, fs, sub) : NA;
      const s = this.slot(`${sub}|param|${p.name}`, p.name, false);
      s.value = v;
      s.bar = this.i;
      fs.vars.set(p.name, s);
    });
    if (++this.depth > 200) throw new PineError("functions call each other too deeply", e.line);
    try {
      return this.execBlock(fn.body.body, fs, sub);
    } finally {
      this.depth--;
    }
  }
  input(e, scope, path) {
    const spec = this.inputByNode.get(e.id);
    const raw = spec && spec.type ? this.params[spec.key] ?? spec.default : undefined;
    if (spec?.type === "source") return this.series(SOURCES.includes(raw) ? raw : "close", this.i);
    if (spec?.dynamic && this.params[spec.key] === undefined) {
      const d = argNode(e, 0, "defval");
      return d ? this.eval(d, scope, path) : NA;
    }
    // a bool saved by the old Settings dialog is "true" or "false"
    if (spec?.type === "bool") return raw === true || raw === "true";
    if (spec?.type === "color") {
      const c = colorFromCss(raw);
      return isNa(c) ? colorFromCss(spec.default) : c;
    }
    if (spec?.type === "text" || spec?.type === "textarea") return String(raw ?? "");
    // "" is the chart's own timeframe, and stays "" as in Pine (scripts test tf == "")
    if (spec?.type === "timeframe") return String(raw ?? "");
    if (spec?.type === "select") {
      if (spec.kind === "bool") return raw === "true" || raw === true;
      if (spec.kind === "int" || spec.kind === "float") return Number(raw);
      return String(raw);
    }
    if (spec?.type === "time") return Number(raw) * 1000;
    if (spec?.type) return Number(raw);
    // not editable here: the script's own default
    const d = argNode(e, 0, "defval");
    return d ? this.eval(d, scope, path) : NA;
  }
}
const SKIP_NOTE = (nm) => (nm.startsWith("label.") ? "Labels aren't drawn here" : nm.startsWith("line.") || nm.startsWith("polyline.") ? "Lines drawn by the script aren't shown here" : nm.startsWith("box.") ? "Boxes aren't drawn here" : nm.startsWith("table.") ? "Tables aren't drawn here" : nm === "fill" || nm.startsWith("linefill.") ? "fill() between plots isn't drawn here" : nm === "bgcolor" ? "bgcolor() isn't drawn here" : nm === "barcolor" ? "barcolor() isn't applied here" : `${nm}() isn't drawn here`);

// "#.##" up to two decimals, "0.00" exactly two, "#,###" grouped, a trailing % times 100.
function patternText(v, fmt) {
  const pct = fmt.endsWith("%");
  if (pct) {
    v *= 100;
    fmt = fmt.slice(0, -1);
  }
  const [ip, fp = ""] = fmt.split(".");
  const minDec = (fp.match(/0/g) || []).length,
    maxDec = fp.length;
  let [a, b = ""] = Math.abs(v).toFixed(maxDec).split(".");
  while (b.length > minDec && b.endsWith("0")) b = b.slice(0, -1);
  a = a.padStart((ip.match(/0/g) || []).length, "0");
  if (ip.includes(",")) a = a.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const neg = v < 0 && /[1-9]/.test(a + b);
  return `${neg ? "-" : ""}${a}${b ? `.${b}` : ""}${pct ? "%" : ""}`;
}
const decimalsOf = (step) => {
  const t = String(step);
  return t.includes("e-") ? Number(t.split("e-")[1]) : (t.split(".")[1] || "").length;
};
function volumeText(v) {
  const a = Math.abs(v);
  const [d, u] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  return `${+(v / d).toFixed(3)}${u}`;
}

function arith(op, a, b) {
  switch (op) {
    case "+":
      return typeof a === "string" || typeof b === "string" ? `${isNa(a) ? "NaN" : a}${isNa(b) ? "NaN" : b}` : a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? NA : a / b;
    case "%":
      return b === 0 ? NA : a % b;
    default:
      return NA;
  }
}
function datePart(nm, ms) {
  const d = new Date(ms);
  switch (nm) {
    case "year":
      return d.getUTCFullYear();
    case "month":
      return d.getUTCMonth() + 1;
    case "dayofmonth":
      return d.getUTCDate();
    case "dayofweek":
      return d.getUTCDay() + 1;
    case "hour":
      return d.getUTCHours();
    case "minute":
      return d.getUTCMinutes();
    case "second":
      return d.getUTCSeconds();
    case "weekofyear": {
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const day = (d.getUTCDay() + 6) % 7;
      const th = new Date(t - day * 86400000 + 3 * 86400000);
      const y0 = Date.UTC(th.getUTCFullYear(), 0, 4);
      return 1 + Math.round((th - y0) / 604800000);
    }
    default:
      return NA;
  }
}
const pineTf = (tf = "") => {
  const m = /^(\d+)([smhDWM])$/.exec(tf);
  if (!m) return tf;
  const n = Number(m[1]);
  return { s: `${n}S`, m: `${n}`, h: `${n * 60}`, D: n === 1 ? "D" : `${n}D`, W: n === 1 ? "W" : `${n}W`, M: n === 1 ? "M" : `${n}M` }[m[2]];
};
export function guessMintick(bars) {
  let dec = 0;
  for (const b of bars.slice(-200)) for (const v of [b.open, b.close]) {
    const s = String(v);
    const k = s.includes(".") ? s.split(".")[1].length : 0;
    if (k > dec) dec = Math.min(k, 8);
  }
  return 10 ** -dec;
}
// Whole-series built-ins that only depend on the bars: worked out once.
function precompute(bars) {
  const n = bars.length,
    tr = new Array(n),
    obv = new Array(n),
    vwap = new Array(n),
    accdist = new Array(n),
    pvt = new Array(n);
  let o = 0,
    pv = 0,
    vv = 0,
    day = null,
    ad = 0,
    pt = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i],
      p = bars[i - 1],
      v = b.volume || 0;
    tr[i] = p ? Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) : NA;
    if (p) o += b.close > p.close ? v : b.close < p.close ? -v : 0;
    obv[i] = o;
    const d = Math.floor(b.time / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vv = 0;
    }
    pv += ((b.high + b.low + b.close) / 3) * v;
    vv += v;
    vwap[i] = vv ? pv / vv : NA;
    ad += b.high !== b.low ? ((b.close - b.low - (b.high - b.close)) / (b.high - b.low)) * v : 0;
    accdist[i] = ad;
    if (p && p.close) pt += ((b.close - p.close) / p.close) * v;
    pvt[i] = pt;
  }
  return { tr, obv, vwap, accdist, pvt };
}

// ======================================================================= built-in functions
// Drawings: the object behind an id (null for na); a different kind is a mistake in the script.
const BLUE = hexColor("#2962FF"),
  BLACK = hexColor("#000000");
function drawingOf(kind, id, e) {
  if (isNa(id)) return null;
  if (id instanceof Drawing && id.kind === kind) return id;
  throw new PineError(`this isn't a ${kind}`, lineOf(e));
}
function cellAt(t, column, row, e) {
  const c = Math.trunc(column), r = Math.trunc(row);
  if (!(c >= 0 && c < t.p.columns && r >= 0 && r < t.p.rows)) throw new PineError(`table cell (${column}, ${row}) is outside the table (${t.p.columns} columns, ${t.p.rows} rows)`, lineOf(e));
  return { column: c, row: r };
}
// <kind>.set_<name>(id, ...): each entry is an argument name, or [argument, property] when they differ.
function setters(kind, idArg, fields) {
  return Object.fromEntries(Object.entries(fields).map(([name, args]) => {
    const pairs = args.map((x) => (Array.isArray(x) ? x : [x, x]));
    return [`${kind}.set_${name}`, { p: [idArg, ...pairs.map(([arg]) => arg)], f: (a, st, e) => {
      const d = drawingOf(kind, a[idArg], e);
      if (d) for (const [arg, prop] of pairs) d.p[prop] = a[arg];
    } }];
  }));
}
function getters(kind, fields) {
  return Object.fromEntries(Object.entries(fields).map(([name, prop]) => [`${kind}.get_${name}`, { p: ["id"], f: (a, st, e) => drawingOf(kind, a.id, e)?.p[prop] ?? NA }]));
}
// Arrays: checks that throw with the script's line, as TradingView stops the script.
const lineOf = (e) => e?.line || 0;
function arr(id, e) {
  if (id instanceof PineArray) return id;
  throw new PineError(isNa(id) ? "this array is na: create it with array.new() first" : "this isn't an array", lineOf(e));
}
function nonEmpty(x, e) {
  if (!x.items.length) throw new PineError("the array is empty", lineOf(e));
  return x;
}
function slotOf(x, index, e, inserting = false) {
  const n = x.items.length;
  let i = Math.trunc(index);
  if (i < 0) i += n;
  if (isNa(index) || i < 0 || i > n || (i === n && !inserting)) throw new PineError(`array index ${index} is out of bounds (the array has ${n} item${n === 1 ? "" : "s"})`, lineOf(e));
  return i;
}
function newArray(size, value) {
  if (!(size >= 0) || size > 100000) throw new PineError("an array holds 0 to 100,000 items");
  return new PineArray(new Array(Math.trunc(size)).fill(value));
}
const same = (x, y) => x === y || (isNa(x) && isNa(y)) || (isColor(x) && isColor(y) && cssColor(x) === cssColor(y));
const nums = (id, e) => arr(id, e).items.filter((v) => typeof v === "number" && !Number.isNaN(v));
const sorter = (order) => (x, y) => {
  if (isNa(x)) return isNa(y) ? 0 : 1;
  if (isNa(y)) return -1;
  const c = typeof x === "string" ? x.localeCompare(y) : x - y;
  return order === "desc" ? -c : c;
};
// Each: p = argument names in order, s = keeps state per call site, f(args, state) = this bar's value.
const win = (st, v, keepNa = false) => {
  const b = (st.buf ||= []);
  if (keepNa || !isNa(v)) b.push(v);
  if (b.length > 5000) b.splice(0, b.length - 5000);
  return b;
};
const lastN = (b, len) => (b.length >= len ? b.slice(b.length - len) : null);
const L = (len) => Math.max(1, Math.round(len));
function emaStep(st, src, alpha, len) {
  if (isNa(src)) return st.val ?? NA;
  if ((st.cnt || 0) < len) {
    st.sum = (st.sum || 0) + src;
    st.cnt = (st.cnt || 0) + 1;
    st.val = st.cnt === len ? st.sum / len : NA;
  } else st.val = alpha * src + (1 - alpha) * st.val;
  return st.val;
}
const sub = (st, k) => (st[k] ||= {});
const smaOf = (st, v, len) => {
  const w = lastN(win(st, v), len);
  return w ? w.reduce((a, x) => a + x, 0) / len : NA;
};
const wmaOf = (st, v, len) => {
  const w = lastN(win(st, v), len);
  if (!w) return NA;
  let s = 0,
    d = 0;
  w.forEach((x, k) => {
    s += x * (k + 1);
    d += k + 1;
  });
  return s / d;
};
const stdevOf = (st, v, len, biased = true) => {
  const w = lastN(win(st, v), len);
  if (!w) return NA;
  const m = w.reduce((a, x) => a + x, 0) / len;
  const ss = w.reduce((a, x) => a + (x - m) ** 2, 0);
  return Math.sqrt(ss / (biased ? len : Math.max(1, len - 1)));
};
const hist = (st, v, keep = 600) => {
  const h = (st.h ||= []);
  h.push(v);
  if (h.length > keep + 50) h.splice(0, h.length - keep);
  return h;
};
const back = (h, k) => (k < h.length ? h[h.length - 1 - k] : NA);
function rsiStep(st, src, len) {
  const prev = st.prev;
  st.prev = src;
  const ch = isNa(prev) || prev === undefined ? NA : src - prev;
  const u = isNa(ch) ? NA : Math.max(ch, 0),
    d = isNa(ch) ? NA : Math.max(-ch, 0);
  const ru = emaStep(sub(st, "u"), u, 1 / len, len),
    rd = emaStep(sub(st, "d"), d, 1 / len, len);
  if (isNa(ru) || isNa(rd)) return NA;
  return rd === 0 ? 100 : ru === 0 ? 0 : 100 - 100 / (1 + ru / rd);
}
const extreme = (w, max) => {
  let best = NA,
    at = -1;
  w.forEach((x, k) => {
    if (isNa(x)) return;
    if (isNa(best) || (max ? x >= best : x <= best)) {
      best = x;
      at = k;
    }
  });
  return [best, at];
};

const BUILTINS = {
  // ---- general
  na: { p: ["x"], f: ({ x }) => isNa(x) },
  nz: { p: ["source", "replacement"], f: ({ source, replacement = 0 }) => (isNa(source) ? replacement : source) },
  // Pine v4's iff(condition, then, else)
  iff: { p: ["condition", "then", "_else"], f: ({ condition, then, _else }) => (!isNa(condition) && condition ? then : _else) },
  fixnan: { p: ["source"], s: 1, f: ({ source }, st) => (isNa(source) ? st.last ?? NA : (st.last = source)) },
  int: { p: ["x"], f: ({ x }) => (isNa(x) ? NA : Math.trunc(x)) },
  float: { p: ["x"], f: ({ x }) => x },
  bool: { p: ["x"], f: ({ x }) => truthy(x) },
  string: { p: ["x"], f: ({ x }) => String(x) },
  timestamp: { p: ["...", "timezone"], f: ({ _rest = [] }) => {
    const nums = _rest.filter((x) => typeof x === "number");
    if (typeof _rest[0] === "string" && !nums.length) return Date.parse(_rest[0]);
    const [y, mo = 1, d = 1, h = 0, mi = 0, s = 0] = nums;
    return Date.UTC(y, mo - 1, d, h, mi, s);
  } },
  "timeframe.in_seconds": { p: ["timeframe"], f: function ({ timeframe }) {
    const tf = timeframe || this.ctx.tf || "1D";
    const m = /^(\d*)([SDWMsmhd]?)$/.exec(String(tf));
    if (!m) return NA;
    const n = Number(m[1] || 1);
    return n * ({ S: 1, s: 1, "": 60, m: 60, h: 3600, D: 86400, d: 86400, W: 604800, M: 2592000 }[m[2]] ?? 60);
  } },
  // ---- drawings (TradingView's defaults; colours stay Pine colours until the run ends)
  "line.new": { p: ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width", "force_overlay"], f: function (a) {
    return this.addDrawing("line", { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, xloc: a.xloc ?? "bar_index", extend: a.extend ?? "none", color: a.color === undefined ? BLUE : a.color, style: a.style ?? "solid", width: a.width ?? 1 });
  } },
  "label.new": { p: ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"], f: function (a) {
    return this.addDrawing("label", { x: a.x, y: a.y, text: a.text ?? "", xloc: a.xloc ?? "bar_index", yloc: a.yloc ?? "price", color: a.color === undefined ? BLUE : a.color, style: a.style ?? "label_down", textcolor: a.textcolor === undefined ? BLACK : a.textcolor, size: a.size ?? "normal", textalign: a.textalign ?? "center" });
  } },
  "box.new": { p: ["left", "top", "right", "bottom", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text", "text_size", "text_color", "text_halign", "text_valign", "text_wrap", "text_font_family", "force_overlay", "text_formatting"], f: function (a) {
    return this.addDrawing("box", { left: a.left, top: a.top, right: a.right, bottom: a.bottom, border_color: a.border_color === undefined ? BLUE : a.border_color, border_width: a.border_width ?? 1, border_style: a.border_style ?? "solid", extend: a.extend ?? "none", xloc: a.xloc ?? "bar_index", bgcolor: a.bgcolor === undefined ? BLUE : a.bgcolor, text: a.text ?? "", text_size: a.text_size ?? "auto", text_color: a.text_color === undefined ? BLACK : a.text_color, text_halign: a.text_halign ?? "center", text_valign: a.text_valign ?? "center" });
  } },
  "linefill.new": { p: ["line1", "line2", "color"], f: function (a, st, e) {
    const l1 = drawingOf("line", a.line1, e), l2 = drawingOf("line", a.line2, e);
    if (!l1 || !l2 || l1.deleted || l2.deleted) return NA;
    return this.addDrawing("linefill", { line1: l1, line2: l2, color: a.color === undefined ? BLUE : a.color });
  } },
  "table.new": { p: ["position", "columns", "rows", "bgcolor", "frame_color", "frame_width", "border_color", "border_width", "force_overlay"], f: function (a, st, e) {
    const columns = Math.trunc(a.columns), rows = Math.trunc(a.rows);
    if (!(columns >= 1 && rows >= 1 && columns * rows <= 10000)) throw new PineError("a table needs at least one column and one row", lineOf(e));
    return this.addDrawing("table", { position: a.position ?? "top_right", columns, rows, bgcolor: a.bgcolor, frame_color: a.frame_color, frame_width: a.frame_width ?? 0, border_color: a.border_color, border_width: a.border_width ?? 0, cells: new Map(), merges: [] });
  } },
  "table.cell": { p: ["table_id", "column", "row", "text", "width", "height", "text_color", "text_halign", "text_valign", "text_size", "bgcolor", "tooltip", "text_font_family", "text_formatting"], f: (a, st, e) => {
    const t = drawingOf("table", a.table_id, e);
    if (!t) return NA;
    const c = cellAt(t, a.column, a.row, e);
    t.p.cells.set(`${c.column},${c.row}`, { ...c, text: a.text ?? "", width: a.width ?? 0, height: a.height ?? 0, text_color: a.text_color === undefined ? BLACK : a.text_color, text_halign: a.text_halign ?? "center", text_valign: a.text_valign ?? "center", text_size: a.text_size ?? "normal", bgcolor: a.bgcolor });
  } },
  "table.clear": { p: ["table_id", "start_column", "start_row", "end_column", "end_row"], f: (a, st, e) => {
    const t = drawingOf("table", a.table_id, e);
    if (!t) return;
    const c0 = a.start_column, r0 = a.start_row, c1 = a.end_column ?? c0, r1 = a.end_row ?? r0;
    for (const [k, c] of t.p.cells) if (c.column >= c0 && c.column <= c1 && c.row >= r0 && c.row <= r1) t.p.cells.delete(k);
  } },
  "table.merge_cells": { p: ["table_id", "start_column", "start_row", "end_column", "end_row"], f: (a, st, e) => {
    const t = drawingOf("table", a.table_id, e);
    if (!t) return;
    const s = cellAt(t, a.start_column, a.start_row, e), z = cellAt(t, a.end_column, a.end_row, e);
    if (z.column < s.column || z.row < s.row) throw new PineError("a merge goes from its top-left cell to its bottom-right cell", lineOf(e));
    if (t.p.merges.length >= t.p.columns * t.p.rows) throw new PineError("too many merged ranges in this table", lineOf(e));
    t.p.merges.push({ c0: s.column, r0: s.row, c1: z.column, r1: z.row });
  } },
  ...Object.fromEntries(["text", "bgcolor", "text_color", "text_size", "text_halign", "text_valign", "width", "height"].map((k) => [`table.cell_set_${k}`, { p: ["table_id", "column", "row", k], f: (a, st, e) => {
    const t = drawingOf("table", a.table_id, e);
    if (!t) return;
    const c = cellAt(t, a.column, a.row, e), key = `${c.column},${c.row}`;
    t.p.cells.set(key, { ...c, text: "", text_color: BLACK, text_halign: "center", text_valign: "center", text_size: "normal", ...t.p.cells.get(key), [k]: a[k] });
  } }])),
  ...setters("table", "table_id", { position: ["position"], bgcolor: ["bgcolor"], frame_color: ["frame_color"], frame_width: ["frame_width"], border_color: ["border_color"], border_width: ["border_width"] }),
  ...setters("line", "id", { x1: [["x", "x1"]], x2: [["x", "x2"]], y1: [["y", "y1"]], y2: [["y", "y2"]], xy1: [["x", "x1"], ["y", "y1"]], xy2: [["x", "x2"], ["y", "y2"]], xloc: [["x1", "x1"], ["x2", "x2"], ["xloc", "xloc"]], color: ["color"], style: ["style"], width: ["width"], extend: ["extend"] }),
  ...setters("label", "id", { x: ["x"], y: ["y"], xy: ["x", "y"], text: ["text"], color: ["color"], textcolor: ["textcolor"], style: ["style"], size: ["size"], textalign: ["textalign"], tooltip: ["tooltip"], xloc: ["x", "xloc"], yloc: ["yloc"], text_font_family: ["text_font_family"] }),
  ...setters("box", "id", { left: ["left"], right: ["right"], top: ["top"], bottom: ["bottom"], lefttop: ["left", "top"], rightbottom: ["right", "bottom"], border_color: [["color", "border_color"]], border_width: [["width", "border_width"]], border_style: [["style", "border_style"]], bgcolor: [["color", "bgcolor"]], extend: ["extend"], text: ["text"], text_color: ["text_color"], text_size: ["text_size"], text_halign: ["text_halign"], text_valign: ["text_valign"], text_wrap: ["text_wrap"], xloc: ["left", "right", "xloc"] }),
  ...setters("linefill", "id", { color: ["color"] }),
  ...getters("line", { x1: "x1", x2: "x2", y1: "y1", y2: "y2" }),
  ...getters("label", { x: "x", y: "y", text: "text" }),
  ...getters("box", { left: "left", right: "right", top: "top", bottom: "bottom" }),
  ...getters("linefill", { line1: "line1", line2: "line2" }),
  "line.get_price": { p: ["id", "x"], f: (a, st, e) => {
    const d = drawingOf("line", a.id, e);
    if (!d) return NA;
    const { x1, y1, x2, y2 } = d.p;
    return x2 === x1 ? y1 : y1 + ((y2 - y1) * (a.x - x1)) / (x2 - x1);
  } },
  ...Object.fromEntries(["line", "label", "box", "linefill", "table"].map((k) => [`${k}.delete`, { p: ["id"], f: function (a, st, e) { const d = drawingOf(k, a.id, e); if (d) this.dropDrawing(d); } }])),
  ...Object.fromEntries(["line", "label", "box"].map((k) => [`${k}.copy`, { p: ["id"], f: function (a, st, e) { const d = drawingOf(k, a.id, e); return d ? this.addDrawing(k, { ...d.p }) : NA; } }])),
  // ---- arrays (references; v6 negative indices count from the end)
  "array.new": { p: ["size", "initial_value"], f: ({ size = 0, initial_value = NA }) => newArray(size, initial_value) },
  ...Object.fromEntries(["float", "int", "string", "color", "line", "label", "box", "table", "linefill"].map((t) => [`array.new_${t}`, { p: ["size", "initial_value"], f: ({ size = 0, initial_value = NA }) => newArray(size, initial_value) }])),
  "array.new_bool": { p: ["size", "initial_value"], f: ({ size = 0, initial_value = false }) => newArray(size, initial_value) },
  "array.from": { p: ["..."], f: ({ _rest = [] }) => new PineArray([..._rest]) },
  "array.size": { p: ["id"], f: (a, st, e) => arr(a.id, e).items.length },
  "array.push": { p: ["id", "value"], f: (a, st, e) => void arr(a.id, e).items.push(a.value) },
  "array.unshift": { p: ["id", "value"], f: (a, st, e) => void arr(a.id, e).items.unshift(a.value) },
  "array.pop": { p: ["id"], f: (a, st, e) => nonEmpty(arr(a.id, e), e).items.pop() },
  "array.shift": { p: ["id"], f: (a, st, e) => nonEmpty(arr(a.id, e), e).items.shift() },
  "array.get": { p: ["id", "index"], f: (a, st, e) => { const x = arr(a.id, e); return x.items[slotOf(x, a.index, e)]; } },
  "array.set": { p: ["id", "index", "value"], f: (a, st, e) => { const x = arr(a.id, e); x.items[slotOf(x, a.index, e)] = a.value; } },
  "array.remove": { p: ["id", "index"], f: (a, st, e) => { const x = arr(a.id, e); return x.items.splice(slotOf(x, a.index, e), 1)[0]; } },
  "array.insert": { p: ["id", "index", "value"], f: (a, st, e) => { const x = arr(a.id, e); x.items.splice(slotOf(x, a.index, e, true), 0, a.value); } },
  "array.clear": { p: ["id"], f: (a, st, e) => void (arr(a.id, e).items.length = 0) },
  "array.first": { p: ["id"], f: (a, st, e) => nonEmpty(arr(a.id, e), e).items[0] },
  "array.last": { p: ["id"], f: (a, st, e) => nonEmpty(arr(a.id, e), e).items.at(-1) },
  "array.includes": { p: ["id", "value"], f: (a, st, e) => arr(a.id, e).items.some((x) => same(x, a.value)) },
  "array.indexof": { p: ["id", "value"], f: (a, st, e) => arr(a.id, e).items.findIndex((x) => same(x, a.value)) },
  "array.lastindexof": { p: ["id", "value"], f: (a, st, e) => arr(a.id, e).items.findLastIndex((x) => same(x, a.value)) },
  "array.slice": { p: ["id", "index_from", "index_to"], f: (a, st, e) => { const x = arr(a.id, e); return new PineArray(x.items.slice(a.index_from ?? 0, a.index_to ?? x.items.length)); } },
  "array.concat": { p: ["id1", "id2"], f: (a, st, e) => { const x = arr(a.id1, e); x.items.push(...arr(a.id2, e).items); return x; } },
  "array.copy": { p: ["id"], f: (a, st, e) => new PineArray([...arr(a.id, e).items]) },
  "array.reverse": { p: ["id"], f: (a, st, e) => void arr(a.id, e).items.reverse() },
  "array.fill": { p: ["id", "value", "index_from", "index_to"], f: (a, st, e) => { const x = arr(a.id, e); x.items.fill(a.value, a.index_from ?? 0, a.index_to ?? x.items.length); } },
  "array.sort": { p: ["id", "order"], f: (a, st, e) => void arr(a.id, e).items.sort(sorter(a.order)) },
  "array.sort_indices": { p: ["id", "order"], f: (a, st, e) => { const x = arr(a.id, e).items, cmp = sorter(a.order); return new PineArray(x.map((_, k) => k).sort((i, j) => cmp(x[i], x[j]))); } },
  "array.join": { p: ["id", "separator"], f: (a, st, e) => arr(a.id, e).items.map((x) => (isNa(x) ? "NaN" : String(x))).join(a.separator ?? "") },
  "array.sum": { p: ["id"], f: (a, st, e) => nums(a.id, e).reduce((s, v) => s + v, 0) },
  "array.avg": { p: ["id"], f: (a, st, e) => { const v = nums(a.id, e); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NA; } },
  "array.min": { p: ["id", "nth"], f: (a, st, e) => nums(a.id, e).sort((x, y) => x - y)[a.nth ?? 0] ?? NA },
  "array.max": { p: ["id", "nth"], f: (a, st, e) => nums(a.id, e).sort((x, y) => y - x)[a.nth ?? 0] ?? NA },
  "array.range": { p: ["id"], f: (a, st, e) => { const v = nums(a.id, e); return v.length ? Math.max(...v) - Math.min(...v) : NA; } },
  "array.median": { p: ["id"], f: (a, st, e) => { const v = nums(a.id, e).sort((x, y) => x - y), m = v.length >> 1; return !v.length ? NA : v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; } },
  "array.stdev": { p: ["id", "biased"], f: (a, st, e) => { const v = nums(a.id, e); if (!v.length) return NA; const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (a.biased === false ? Math.max(1, v.length - 1) : v.length)); } },
  "array.every": { p: ["id"], f: (a, st, e) => arr(a.id, e).items.every(truthy) },
  "array.some": { p: ["id"], f: (a, st, e) => arr(a.id, e).items.some(truthy) },
  "array.abs": { p: ["id"], f: (a, st, e) => new PineArray(arr(a.id, e).items.map((x) => (isNa(x) ? NA : Math.abs(x)))) },
  // ---- math
  "math.abs": { p: ["number"], f: ({ number }) => Math.abs(number) },
  "math.ceil": { p: ["number"], f: ({ number }) => Math.ceil(number) },
  "math.floor": { p: ["number"], f: ({ number }) => Math.floor(number) },
  "math.round": { p: ["number", "precision"], f: ({ number, precision }) => (precision ? Math.round(number * 10 ** precision) / 10 ** precision : Math.round(number)) },
  "math.round_to_mintick": { p: ["number"], f: function ({ number }) { return Math.round(number / this.mintick) * this.mintick; } },
  "math.sqrt": { p: ["number"], f: ({ number }) => Math.sqrt(number) },
  "math.pow": { p: ["base", "exponent"], f: ({ base, exponent }) => base ** exponent },
  "math.exp": { p: ["number"], f: ({ number }) => Math.exp(number) },
  "math.log": { p: ["number"], f: ({ number }) => Math.log(number) },
  "math.log10": { p: ["number"], f: ({ number }) => Math.log10(number) },
  "math.sign": { p: ["number"], f: ({ number }) => Math.sign(number) },
  "math.sin": { p: ["angle"], f: ({ angle }) => Math.sin(angle) },
  "math.cos": { p: ["angle"], f: ({ angle }) => Math.cos(angle) },
  "math.tan": { p: ["angle"], f: ({ angle }) => Math.tan(angle) },
  "math.asin": { p: ["angle"], f: ({ angle }) => Math.asin(angle) },
  "math.acos": { p: ["angle"], f: ({ angle }) => Math.acos(angle) },
  "math.atan": { p: ["angle"], f: ({ angle }) => Math.atan(angle) },
  "math.todegrees": { p: ["radians"], f: ({ radians }) => (radians * 180) / Math.PI },
  "math.toradians": { p: ["degrees"], f: ({ degrees }) => (degrees * Math.PI) / 180 },
  "math.max": { p: ["..."], f: ({ _rest = [] }) => (_rest.some(isNa) ? NA : Math.max(..._rest)) },
  "math.min": { p: ["..."], f: ({ _rest = [] }) => (_rest.some(isNa) ? NA : Math.min(..._rest)) },
  "math.avg": { p: ["..."], f: ({ _rest = [] }) => (_rest.some(isNa) ? NA : _rest.reduce((a, x) => a + x, 0) / _rest.length) },
  "math.sum": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const w = lastN(win(st, source, true), L(length));
    return w && !w.some(isNa) ? w.reduce((a, x) => a + x, 0) : NA;
  } },
  "math.random": { p: ["min", "max", "seed"], s: 1, f: ({ min = 0, max = 1, seed }, st) => {
    st.x = st.x ?? (seed || 12345);
    st.x = (st.x * 1103515245 + 12345) % 2147483648;
    return min + (st.x / 2147483648) * (max - min);
  } },
  // ---- strings
  "str.tostring": { p: ["value", "format"], f: function ({ value, format }) {
    if (value instanceof PineArray) return `[${value.items.map((x) => (isNa(x) ? "NaN" : typeof x === "number" ? String(+x.toFixed(8)) : String(x))).join(", ")}]`;
    if (isNa(value)) return "NaN";
    if (typeof value !== "number") return String(value);
    if (format === "percent") return `${value.toFixed(2)}%`;
    if (format === "mintick") return value.toFixed(decimalsOf(this.mintick));
    if (format === "volume") return volumeText(value);
    if (typeof format === "string" && format && /^[#0,]*(\.[#0]*)?%?$/.test(format)) return patternText(value, format);
    return String(+value.toFixed(8));
  } },
  "str.format": { p: ["formatString", "..."], f: ({ formatString, _rest = [] }) => String(formatString).replace(/\{(\d+)(?:,[^}]*)?\}/g, (m, k) => (_rest[k] === undefined ? m : isNa(_rest[k]) ? "NaN" : String(_rest[k]))) },
  "str.length": { p: ["string"], f: ({ string }) => String(string).length },
  "str.contains": { p: ["source", "str"], f: ({ source, str }) => String(source).includes(str) },
  "str.upper": { p: ["source"], f: ({ source }) => String(source).toUpperCase() },
  "str.lower": { p: ["source"], f: ({ source }) => String(source).toLowerCase() },
  "str.replace_all": { p: ["source", "target", "replacement"], f: ({ source, target, replacement }) => String(source).split(target).join(replacement) },
  // the occurrence-th match (from 0) of target, replaced; the string as it was when there isn't one
  "str.replace": { p: ["source", "target", "replacement", "occurrence"], f: ({ source, target, replacement, occurrence = 0 }) => {
    const src = String(source),
      t = String(target);
    if (!t) return src;
    let k = -1;
    for (let n = 0; n <= Math.trunc(occurrence); n++) if ((k = src.indexOf(t, k + 1)) < 0) return src;
    return src.slice(0, k) + String(replacement) + src.slice(k + t.length);
  } },
  "str.tonumber": { p: ["string"], f: ({ string }) => (Number.isFinite(Number(string)) ? Number(string) : NA) },
  // an empty separator splits into characters, as on TradingView
  "str.split": { p: ["string", "separator"], f: ({ string, separator }) => new PineArray(String(string).split(String(separator ?? ""))) },
  "str.trim": { p: ["source"], f: ({ source }) => String(source).trim() },
  // from begin_pos up to, not including, end_pos (to the end without one)
  "str.substring": { p: ["source", "begin_pos", "end_pos"], f: ({ source, begin_pos, end_pos }) => String(source).substring(begin_pos, isNa(end_pos) ? undefined : end_pos) },
  "str.startswith": { p: ["source", "str"], f: ({ source, str }) => String(source).startsWith(String(str)) },
  "str.endswith": { p: ["source", "str"], f: ({ source, str }) => String(source).endsWith(String(str)) },
  "str.pos": { p: ["source", "str"], f: ({ source, str }) => {
    const k = String(source).indexOf(String(str));
    return k < 0 ? NA : k;
  } },
  // stops the script with the script's own message, as TradingView's does
  "runtime.error": { p: ["message"], f: function ({ message }) {
    throw new PineError(String(message ?? "runtime.error"), this.line);
  } },
  // ---- colours
  "color.new": { p: ["color", "transp"], f: ({ color, transp = 0 }) => (isColor(color) ? { ...color, a: color.a * (1 - transp / 100) } : NA) },
  "color.rgb": { p: ["red", "green", "blue", "transp"], f: ({ red, green, blue, transp = 0 }) => rgba(red, green, blue, 1 - transp / 100) },
  "color.r": { p: ["color"], f: ({ color }) => color?.r ?? NA },
  "color.g": { p: ["color"], f: ({ color }) => color?.g ?? NA },
  "color.b": { p: ["color"], f: ({ color }) => color?.b ?? NA },
  "color.t": { p: ["color"], f: ({ color }) => (isColor(color) ? (1 - color.a) * 100 : NA) },
  "color.from_gradient": { p: ["value", "bottom_value", "top_value", "bottom_color", "top_color"], f: ({ value, bottom_value, top_value, bottom_color, top_color }) => {
    if ([value, bottom_value, top_value].some(isNa) || !isColor(bottom_color) || !isColor(top_color)) return NA;
    const t = Math.max(0, Math.min(1, (value - bottom_value) / (top_value - bottom_value || 1)));
    const m = (a, b) => a + (b - a) * t;
    return rgba(m(bottom_color.r, top_color.r), m(bottom_color.g, top_color.g), m(bottom_color.b, top_color.b), m(bottom_color.a, top_color.a));
  } },
  // ---- moving averages and friends
  "ta.sma": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => smaOf(st, source, L(length)) },
  "ta.ema": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => emaStep(st, source, 2 / (L(length) + 1), L(length)) },
  "ta.rma": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => emaStep(st, source, 1 / L(length), L(length)) },
  "ta.wma": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => wmaOf(st, source, L(length)) },
  "ta.vwma": { p: ["source", "length"], s: 1, f: function ({ source, length }, st) {
    const v = this.bars[this.i].volume || 0;
    const a = smaOf(sub(st, "a"), source * v, L(length)),
      b = smaOf(sub(st, "b"), isNa(source) ? NA : v, L(length));
    return b ? a / b : NA;
  } },
  "ta.hma": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const len = L(length);
    const half = wmaOf(sub(st, "h"), source, L(len / 2)),
      full = wmaOf(sub(st, "f"), source, len);
    return wmaOf(sub(st, "o"), isNa(half) || isNa(full) ? NA : 2 * half - full, L(Math.floor(Math.sqrt(len))));
  } },
  "ta.swma": { p: ["source"], s: 1, f: ({ source }, st) => {
    const w = lastN(win(st, source, true), 4);
    return w ? (w[0] + 2 * w[1] + 2 * w[2] + w[3]) / 6 : NA;
  } },
  "ta.alma": { p: ["series", "length", "offset", "sigma", "floor"], s: 1, f: ({ series, length, offset = 0.85, sigma = 6, floor = false }, st) => {
    const len = L(length),
      w = lastN(win(st, series), len);
    if (!w) return NA;
    const m = floor ? Math.floor(offset * (len - 1)) : offset * (len - 1),
      s = len / sigma;
    let num = 0,
      den = 0;
    for (let k = 0; k < len; k++) {
      const wt = Math.exp(-((k - m) ** 2) / (2 * s * s));
      num += wt * w[k];
      den += wt;
    }
    return num / den;
  } },
  "ta.linreg": { p: ["source", "length", "offset"], s: 1, f: ({ source, length, offset = 0 }, st) => {
    const len = L(length),
      w = lastN(win(st, source), len);
    if (!w) return NA;
    let sx = 0,
      sy = 0,
      sxy = 0,
      sxx = 0;
    w.forEach((y, x) => {
      sx += x;
      sy += y;
      sxy += x * y;
      sxx += x * x;
    });
    const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx || 1),
      icpt = (sy - slope * sx) / len;
    return icpt + slope * (len - 1 - offset);
  } },
  // ---- oscillators
  "ta.rsi": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => rsiStep(st, source, L(length)) },
  "ta.macd": { p: ["source", "fastlen", "slowlen", "siglen"], s: 1, f: ({ source, fastlen, slowlen, siglen }, st) => {
    const f = emaStep(sub(st, "f"), source, 2 / (L(fastlen) + 1), L(fastlen)),
      s = emaStep(sub(st, "s"), source, 2 / (L(slowlen) + 1), L(slowlen));
    const m = isNa(f) || isNa(s) ? NA : f - s;
    const sig = emaStep(sub(st, "g"), m, 2 / (L(siglen) + 1), L(siglen));
    return [m, sig, m - sig];
  } },
  "ta.stoch": { p: ["source", "high", "low", "length"], s: 1, f: ({ source, high, low, length }, st) => {
    const len = L(length);
    const hh = lastN(win(sub(st, "h"), high, true), len),
      ll = lastN(win(sub(st, "l"), low, true), len);
    if (!hh || !ll) return NA;
    const H = Math.max(...hh),
      Lo = Math.min(...ll);
    return H === Lo ? NA : (100 * (source - Lo)) / (H - Lo);
  } },
  "ta.cci": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const len = L(length),
      w = lastN(win(st, source), len);
    if (!w) return NA;
    const m = w.reduce((a, x) => a + x, 0) / len,
      dev = w.reduce((a, x) => a + Math.abs(x - m), 0) / len;
    return dev ? (source - m) / (0.015 * dev) : 0;
  } },
  "ta.mfi": { p: ["series", "length"], s: 1, f: function ({ series, length }, st) {
    const v = this.bars[this.i].volume || 0,
      prev = st.prev;
    st.prev = series;
    const ch = isNa(prev) || prev === undefined ? NA : series - prev;
    const up = lastN(win(sub(st, "u"), isNa(ch) ? NA : ch > 0 ? v * series : 0, true), L(length)),
      dn = lastN(win(sub(st, "d"), isNa(ch) ? NA : ch < 0 ? v * series : 0, true), L(length));
    if (!up || up.some(isNa)) return NA;
    const U = up.reduce((a, x) => a + x, 0),
      D = dn.reduce((a, x) => a + x, 0);
    return D === 0 ? 100 : 100 - 100 / (1 + U / D);
  } },
  "ta.wpr": { p: ["length"], s: 1, f: function ({ length }, st) {
    const b = this.bars[this.i],
      len = L(length);
    const hh = lastN(win(sub(st, "h"), b.high, true), len),
      ll = lastN(win(sub(st, "l"), b.low, true), len);
    if (!hh) return NA;
    const H = Math.max(...hh),
      Lo = Math.min(...ll);
    return H === Lo ? NA : (100 * (b.close - H)) / (H - Lo);
  } },
  "ta.cmo": { p: ["series", "length"], s: 1, f: ({ series, length }, st) => {
    const prev = st.prev;
    st.prev = series;
    const ch = isNa(prev) || prev === undefined ? NA : series - prev;
    const w = lastN(win(sub(st, "c"), ch, true), L(length));
    if (!w || w.some(isNa)) return NA;
    const su = w.reduce((a, x) => a + Math.max(x, 0), 0),
      sd = w.reduce((a, x) => a + Math.max(-x, 0), 0);
    return su + sd ? (100 * (su - sd)) / (su + sd) : 0;
  } },
  "ta.tsi": { p: ["source", "short_length", "long_length"], s: 1, f: ({ source, short_length, long_length }, st) => {
    const prev = st.prev;
    st.prev = source;
    const pc = isNa(prev) || prev === undefined ? NA : source - prev;
    const a = emaStep(sub(st, "a2"), emaStep(sub(st, "a1"), pc, 2 / (L(long_length) + 1), L(long_length)), 2 / (L(short_length) + 1), L(short_length));
    const b = emaStep(sub(st, "b2"), emaStep(sub(st, "b1"), isNa(pc) ? NA : Math.abs(pc), 2 / (L(long_length) + 1), L(long_length)), 2 / (L(short_length) + 1), L(short_length));
    return b ? a / b : NA;
  } },
  // ---- volatility and bands
  "ta.stdev": { p: ["source", "length", "biased"], s: 1, f: ({ source, length, biased = true }, st) => stdevOf(st, source, L(length), biased) },
  "ta.variance": { p: ["source", "length", "biased"], s: 1, f: ({ source, length, biased = true }, st) => stdevOf(st, source, L(length), biased) ** 2 },
  "ta.dev": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const len = L(length),
      w = lastN(win(st, source), len);
    if (!w) return NA;
    const m = w.reduce((a, x) => a + x, 0) / len;
    return w.reduce((a, x) => a + Math.abs(x - m), 0) / len;
  } },
  "ta.tr": { p: ["handle_na"], f: function ({ handle_na = false }) {
    const b = this.bars[this.i],
      p = this.bars[this.i - 1];
    return p ? Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) : handle_na ? b.high - b.low : NA;
  } },
  "ta.atr": { p: ["length"], s: 1, f: function ({ length }, st) {
    const b = this.bars[this.i],
      p = this.bars[this.i - 1];
    const tr = p ? Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) : b.high - b.low;
    return emaStep(st, tr, 1 / L(length), L(length));
  } },
  "ta.bb": { p: ["series", "length", "mult"], s: 1, f: ({ series, length, mult }, st) => {
    const m = smaOf(sub(st, "m"), series, L(length)),
      d = stdevOf(sub(st, "d"), series, L(length));
    return [m, m + mult * d, m - mult * d];
  } },
  "ta.bbw": { p: ["series", "length", "mult"], s: 1, f: ({ series, length, mult }, st) => {
    const m = smaOf(sub(st, "m"), series, L(length)),
      d = stdevOf(sub(st, "d"), series, L(length));
    return m ? (2 * mult * d) / m : NA;
  } },
  "ta.kc": { p: ["series", "length", "mult", "useTrueRange"], s: 1, f: function ({ series, length, mult, useTrueRange = true }, st) {
    const b = this.bars[this.i],
      p = this.bars[this.i - 1];
    const rng = useTrueRange ? (p ? Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) : b.high - b.low) : b.high - b.low;
    const len = L(length);
    const m = emaStep(sub(st, "m"), series, 2 / (len + 1), len),
      r = emaStep(sub(st, "r"), rng, 2 / (len + 1), len);
    return [m, m + mult * r, m - mult * r];
  } },
  // ---- highest, lowest, changes
  "ta.highest": { p: ["source", "length"], s: 1, f: function (a, st) {
    const [src, len] = a.length === undefined ? [this.bars[this.i].high, a.source] : [a.source, a.length];
    const w = lastN(win(st, src, true), L(len));
    return w ? extreme(w, true)[0] : NA;
  } },
  "ta.lowest": { p: ["source", "length"], s: 1, f: function (a, st) {
    const [src, len] = a.length === undefined ? [this.bars[this.i].low, a.source] : [a.source, a.length];
    const w = lastN(win(st, src, true), L(len));
    return w ? extreme(w, false)[0] : NA;
  } },
  "ta.highestbars": { p: ["source", "length"], s: 1, f: function (a, st) {
    const [src, len] = a.length === undefined ? [this.bars[this.i].high, a.source] : [a.source, a.length];
    const w = lastN(win(st, src, true), L(len));
    return w ? extreme(w, true)[1] - (w.length - 1) : NA;
  } },
  "ta.lowestbars": { p: ["source", "length"], s: 1, f: function (a, st) {
    const [src, len] = a.length === undefined ? [this.bars[this.i].low, a.source] : [a.source, a.length];
    const w = lastN(win(st, src, true), L(len));
    return w ? extreme(w, false)[1] - (w.length - 1) : NA;
  } },
  "ta.change": { p: ["source", "length"], s: 1, f: ({ source, length = 1 }, st) => {
    const h = hist(st, source);
    const prev = back(h, L(length));
    return typeof source === "boolean" ? source !== prev : source - prev;
  } },
  "ta.mom": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => source - back(hist(st, source), L(length)) },
  "ta.roc": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const p = back(hist(st, source), L(length));
    return p ? (100 * (source - p)) / p : NA;
  } },
  "ta.rising": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const h = hist(st, source);
    for (let k = 1; k <= L(length); k++) if (!(source > back(h, k))) return false;
    return true;
  } },
  "ta.falling": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const h = hist(st, source);
    for (let k = 1; k <= L(length); k++) if (!(source < back(h, k))) return false;
    return true;
  } },
  "ta.cum": { p: ["source"], s: 1, f: ({ source }, st) => (st.v = (st.v || 0) + (isNa(source) ? 0 : source)) },
  "ta.max": { p: ["source"], s: 1, f: ({ source }, st) => (isNa(source) ? st.v ?? NA : (st.v = isNa(st.v ?? NA) ? source : Math.max(st.v, source))) },
  "ta.min": { p: ["source"], s: 1, f: ({ source }, st) => (isNa(source) ? st.v ?? NA : (st.v = isNa(st.v ?? NA) ? source : Math.min(st.v, source))) },
  "ta.range": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const w = lastN(win(st, source, true), L(length));
    return w ? extreme(w, true)[0] - extreme(w, false)[0] : NA;
  } },
  "ta.median": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const w = lastN(win(st, source), L(length));
    if (!w) return NA;
    const s = [...w].sort((a, b) => a - b),
      m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  } },
  // TradingView's nearest rank: of the last length values, the one that percentage % of them are at or below
  "ta.percentile_nearest_rank": { p: ["source", "length", "percentage"], s: 1, f: ({ source, length, percentage }, st) => {
    const w = lastN(win(st, source), L(length));
    if (!w || isNa(percentage)) return NA;
    const s = [...w].sort((a, b) => a - b);
    return s[Math.max(0, Math.ceil((Math.min(100, Math.max(0, percentage)) / 100) * s.length) - 1)];
  } },
  "ta.percentrank": { p: ["source", "length"], s: 1, f: ({ source, length }, st) => {
    const h = lastN(win(st, source, true), L(length) + 1);
    if (!h) return NA;
    const prev = h.slice(0, -1);
    return (100 * prev.filter((x) => x <= source).length) / prev.length;
  } },
  "ta.correlation": { p: ["source1", "source2", "length"], s: 1, f: ({ source1, source2, length }, st) => {
    const len = L(length),
      a = lastN(win(sub(st, "a"), source1, true), len),
      b = lastN(win(sub(st, "b"), source2, true), len);
    if (!a || !b || a.some(isNa) || b.some(isNa)) return NA;
    const ma = a.reduce((x, y) => x + y, 0) / len,
      mb = b.reduce((x, y) => x + y, 0) / len;
    let num = 0,
      da = 0,
      db = 0;
    for (let k = 0; k < len; k++) {
      num += (a[k] - ma) * (b[k] - mb);
      da += (a[k] - ma) ** 2;
      db += (b[k] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : NA;
  } },
  // ---- crosses and events
  "ta.cross": { p: ["source1", "source2"], s: 1, f: ({ source1: a, source2: b }, st) => {
    const r = !isNa(st.a) && st.a !== undefined && ((a > b && st.a <= st.b) || (a < b && st.a >= st.b));
    st.a = a;
    st.b = b;
    return r;
  } },
  "ta.crossover": { p: ["source1", "source2"], s: 1, f: ({ source1: a, source2: b }, st) => {
    const r = st.a !== undefined && a > b && st.a <= st.b;
    st.a = a;
    st.b = b;
    return r;
  } },
  "ta.crossunder": { p: ["source1", "source2"], s: 1, f: ({ source1: a, source2: b }, st) => {
    const r = st.a !== undefined && a < b && st.a >= st.b;
    st.a = a;
    st.b = b;
    return r;
  } },
  "ta.barssince": { p: ["condition"], s: 1, f: function ({ condition }, st) {
    if (truthy(condition)) st.at = this.i;
    return st.at === undefined ? NA : this.i - st.at;
  } },
  "ta.valuewhen": { p: ["condition", "source", "occurrence"], s: 1, f: ({ condition, source, occurrence = 0 }, st) => {
    const v = (st.v ||= []);
    if (truthy(condition)) {
      v.push(source);
      if (v.length > 500) v.shift();
    }
    const k = v.length - 1 - Math.round(occurrence);
    return k >= 0 ? v[k] : NA;
  } },
  "ta.pivothigh": { p: ["source", "leftbars", "rightbars"], s: 1, f: function (a, st) {
    const [src, lb, rb] = a.rightbars === undefined ? [this.bars[this.i].high, a.source, a.leftbars] : [a.source, a.leftbars, a.rightbars];
    const w = lastN(win(st, src, true), L(lb) + L(rb) + 1);
    if (!w) return NA;
    const c = w[L(lb)];
    if (isNa(c)) return NA;
    for (let k = 0; k < w.length; k++) if (k !== L(lb) && !(w[k] < c)) return NA;
    return c;
  } },
  "ta.pivotlow": { p: ["source", "leftbars", "rightbars"], s: 1, f: function (a, st) {
    const [src, lb, rb] = a.rightbars === undefined ? [this.bars[this.i].low, a.source, a.leftbars] : [a.source, a.leftbars, a.rightbars];
    const w = lastN(win(st, src, true), L(lb) + L(rb) + 1);
    if (!w) return NA;
    const c = w[L(lb)];
    if (isNa(c)) return NA;
    for (let k = 0; k < w.length; k++) if (k !== L(lb) && !(w[k] > c)) return NA;
    return c;
  } },
  // ---- trend systems
  "ta.supertrend": { p: ["factor", "atrPeriod"], s: 1, f: function ({ factor, atrPeriod }, st) {
    const b = this.bars[this.i],
      p = this.bars[this.i - 1];
    const tr = p ? Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) : b.high - b.low;
    const atr = emaStep(sub(st, "atr"), tr, 1 / L(atrPeriod), L(atrPeriod));
    const src = (b.high + b.low) / 2;
    let up = src + factor * atr,
      lo = src - factor * atr;
    const pl = st.lo ?? 0,
      pu = st.up ?? 0,
      pst = st.st;
    lo = lo > pl || (p && p.close < pl) ? lo : pl;
    up = up < pu || (p && p.close > pu) ? up : pu;
    let dir;
    if (isNa(st.prevAtr ?? NA)) dir = 1;
    else if (pst === pu) dir = b.close > up ? -1 : 1;
    else dir = b.close < lo ? 1 : -1;
    const stv = dir === -1 ? lo : up;
    Object.assign(st, { lo: isNa(lo) ? 0 : lo, up: isNa(up) ? 0 : up, st: stv, prevAtr: atr });
    return [isNa(atr) ? NA : stv, isNa(atr) ? NA : dir];
  } },
  "ta.dmi": { p: ["diLength", "adxSmoothing"], s: 1, f: function ({ diLength, adxSmoothing }, st) {
    const b = this.bars[this.i],
      p = this.bars[this.i - 1];
    const upm = p ? b.high - p.high : NA,
      dnm = p ? p.low - b.low : NA;
    const plusDM = isNa(upm) ? NA : upm > dnm && upm > 0 ? upm : 0,
      minusDM = isNa(dnm) ? NA : dnm > upm && dnm > 0 ? dnm : 0;
    const tr = p ? Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) : NA;
    const len = L(diLength);
    const trur = emaStep(sub(st, "tr"), tr, 1 / len, len);
    let plus = (100 * emaStep(sub(st, "p"), plusDM, 1 / len, len)) / trur,
      minus = (100 * emaStep(sub(st, "m"), minusDM, 1 / len, len)) / trur;
    plus = isNa(plus) ? st.lp ?? NA : (st.lp = plus);
    minus = isNa(minus) ? st.lm ?? NA : (st.lm = minus);
    const sum = plus + minus;
    const adx = 100 * emaStep(sub(st, "a"), isNa(sum) ? NA : Math.abs(plus - minus) / (sum === 0 ? 1 : sum), 1 / L(adxSmoothing), L(adxSmoothing));
    return [plus, minus, adx];
  } },
  "ta.sar": { p: ["start", "inc", "max"], s: 1, f: function ({ start, inc, max }, st) {
    const b = this.bars[this.i],
      p = this.bars[this.i - 1];
    if (!p) return NA;
    if (st.sar === undefined) {
      st.long = b.close > p.close;
      st.sar = st.long ? Math.min(p.low, b.low) : Math.max(p.high, b.high);
      st.ep = st.long ? b.high : b.low;
      st.af = start;
      return st.sar;
    }
    let sar = st.sar + st.af * (st.ep - st.sar);
    if (st.long) {
      sar = Math.min(sar, p.low, this.bars[this.i - 2]?.low ?? p.low);
      if (b.low < sar) {
        st.long = false;
        sar = st.ep;
        st.ep = b.low;
        st.af = start;
      } else if (b.high > st.ep) {
        st.ep = b.high;
        st.af = Math.min(max, st.af + inc);
      }
    } else {
      sar = Math.max(sar, p.high, this.bars[this.i - 2]?.high ?? p.high);
      if (b.high > sar) {
        st.long = true;
        sar = st.ep;
        st.ep = b.high;
        st.af = start;
      } else if (b.low < st.ep) {
        st.ep = b.low;
        st.af = Math.min(max, st.af + inc);
      }
    }
    st.sar = sar;
    return sar;
  } },
  "ta.vwap": { p: ["source", "anchor", "stdev_mult"], s: 1, f: function ({ source, anchor }, st) {
    const b = this.bars[this.i],
      v = b.volume || 0,
      d = Math.floor(b.time / 86400);
    const reset = anchor === undefined ? d !== st.day : truthy(anchor);
    if (reset || st.pv === undefined) {
      st.pv = 0;
      st.vv = 0;
      st.day = d;
    }
    st.pv += source * v;
    st.vv += v;
    return st.vv ? st.pv / st.vv : NA;
  } },
  // ---- output
  plot: { p: ["series", "title", "color", "linewidth", "style", "trackprice", "histbase", "offset", "join", "editable", "show_last", "display", "format", "precision", "force_overlay", "transp"], f: function (a, _, e) {
    const spec = this.plotByNode.get(e.id);
    if (!spec) return NA;
    const arr = (this.plotVals[spec.key] ||= new Array(this.n).fill(NA));
    const v = a.series,
      at = this.i + Math.round(Number(a.offset) || 0); // offset= draws it that many bars over
    if (at < 0 || at >= this.n) return { plot: spec.key };
    arr[at] = typeof v === "boolean" ? (v ? 1 : 0) : isNa(v) ? NA : Number(v);
    if (spec.dynamicColor) (this.plotColors[spec.key] ||= new Array(this.n).fill(null))[at] = isColor(a.color) ? cssColor(a.color) : "rgba(0,0,0,0)";
    return { plot: spec.key };
  } },
  plotshape: { p: ["series", "title", "style", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay", "transp"], f: function (a, st, e) {
    if (truthy(a.series)) this.mark(a.style || "xcross", a.location || "abovebar", a.color, a.text, a.offset, this.plotByNode.get(e?.id)?.key);
    return NA;
  } },
  plotchar: { p: ["series", "title", "char", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay", "transp"], f: function (a, st, e) {
    if (truthy(a.series)) this.mark("circle", a.location || "abovebar", a.color, a.text || a.char || "", a.offset, this.plotByNode.get(e?.id)?.key);
    return NA;
  } },
  hline: { p: ["price", "title", "color", "linestyle", "linewidth", "editable", "display"], f: () => NA },
  // ---- strategy orders
  "strategy.entry": { p: ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "when", "disable_alert"], f: function (a) {
    this.needStrat("strategy.entry");
    if (a.when !== undefined && !truthy(a.when)) return NA;
    this.strat.entry(a);
    return NA;
  } },
  "strategy.order": { p: ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "when", "disable_alert"], f: function (a) {
    this.needStrat("strategy.order");
    if (a.when !== undefined && !truthy(a.when)) return NA;
    this.strat.entry({ ...a, order: true });
    return NA;
  } },
  "strategy.close": { p: ["id", "comment", "qty", "qty_percent", "alert_message", "immediately", "when", "disable_alert"], f: function (a) {
    this.needStrat("strategy.close");
    if (a.when !== undefined && !truthy(a.when)) return NA;
    this.strat.close(a.id, a.comment, a.immediately);
    return NA;
  } },
  "strategy.close_all": { p: ["comment", "alert_message", "immediately", "when", "disable_alert"], f: function (a) {
    this.needStrat("strategy.close_all");
    if (a.when !== undefined && !truthy(a.when)) return NA;
    this.strat.close(null, a.comment, a.immediately);
    return NA;
  } },
  "strategy.exit": { p: ["id", "from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points", "trail_offset", "oca_name", "comment", "comment_profit", "comment_loss", "comment_trailing", "alert_message", "alert_profit", "alert_loss", "alert_trailing", "when", "disable_alert"], f: function (a) {
    this.needStrat("strategy.exit");
    if (a.when !== undefined && !truthy(a.when)) return NA;
    this.strat.exit(a);
    return NA;
  } },
  "strategy.cancel": { p: ["id", "when"], f: function (a) {
    this.needStrat("strategy.cancel");
    if (a.when === undefined || truthy(a.when)) this.strat.cancel(a.id);
    return NA;
  } },
  "strategy.cancel_all": { p: ["when"], f: function (a) {
    this.needStrat("strategy.cancel_all");
    if (a.when === undefined || truthy(a.when)) this.strat.cancel(null);
    return NA;
  } },
  // the open trades, oldest first (trade_num 0), as on TradingView; na for a number that isn't open
  ...Object.fromEntries(
    Object.entries({
      entry_price: (t) => t.price,
      entry_bar_index: (t) => t.index,
      entry_time: (t) => t.time * 1000,
      entry_id: (t) => t.id,
      entry_comment: (t) => t.comment ?? "",
      size: (t) => t.dir * t.qty,
      commission: (t) => t.fee,
      profit: (t, s) => t.dir * t.qty * (s.bars[s.i].close - t.price) - t.fee,
    }).map(([k, get]) => [
      `strategy.opentrades.${k}`,
      { p: ["trade_num"], f: function ({ trade_num }) {
        this.needStrat(`strategy.opentrades.${k}`);
        const t = this.strat.entries[Math.trunc(trade_num)];
        return t ? get(t, this.strat) : NA;
      } },
    ]),
  ),
  "strategy.risk.allow_entry_in": { p: ["value"], f: function (a) {
    this.needStrat("strategy.risk.allow_entry_in");
    this.strat.allow = a.value;
    return NA;
  } },
};
Object.setPrototypeOf(BUILTINS, null);

// ---------- drawings: lines, labels, boxes, linefills and tables
Runtime.prototype.addDrawing = function (kind, props) {
  const d = new Drawing(kind, props);
  const list = this.drawn[kind];
  list.push(d);
  while (list.length > this.drawMax[kind]) this.dropDrawing(list[0]); // the oldest goes, as on TradingView
  return d;
};
Runtime.prototype.dropDrawing = function (d) {
  if (!(d instanceof Drawing) || d.deleted) return;
  d.deleted = true;
  const list = this.drawn[d.kind];
  const k = list.indexOf(d);
  if (k >= 0) list.splice(k, 1);
  // a linefill goes with either of its lines
  if (d.kind === "line") for (const f of [...this.drawn.linefill]) if (f.p.line1 === d || f.p.line2 === d) this.dropDrawing(f);
};
// Values a script picks for a drawing's style, size, place and alignment, each checked against what
// TradingView has; anything else (a typo, "constructor") falls back to the default.
const ONE_OF = (list) => new Set(list);
const DRAW_ENUMS = {
  lineStyle: ONE_OF(["solid", "dotted", "dashed", "arrow_left", "arrow_right", "arrow_both"]),
  extend: ONE_OF(["none", "left", "right", "both"]),
  labelStyle: ONE_OF(["none", "xcross", "cross", "triangleup", "triangledown", "flag", "circle", "arrowup", "arrowdown", "label_up", "label_down", "label_left", "label_right", "label_center", "label_lower_left", "label_lower_right", "label_upper_left", "label_upper_right", "square", "diamond", "text_outline"]),
  size: ONE_OF(["auto", "tiny", "small", "normal", "large", "huge"]),
  yloc: ONE_OF(["price", "abovebar", "belowbar"]),
  position: ONE_OF(["top_left", "top_center", "top_right", "middle_left", "middle_center", "middle_right", "bottom_left", "bottom_center", "bottom_right"]),
  halign: ONE_OF(["left", "center", "right"]),
  valign: ONE_OF(["top", "center", "bottom"]),
};
const pick = (v, kind, fallback) => (DRAW_ENUMS[kind].has(v) ? v : fallback);

// What's left when the run ends, as plain values for the chart: x as a (possibly fractional or
// future) bar index, colours as CSS (null for na), text as text. Nothing here is ever HTML.
Runtime.prototype.drawingsOut = function () {
  const d = this.drawn;
  if (!d.line.length && !d.label.length && !d.box.length && !d.linefill.length && !d.table.length) return null;
  const bars = this.bars;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const col = (c) => (isColor(c) ? cssColor(c) : null);
  const txt = (t, max = 4000) => (isNa(t) ? "" : String(t).slice(0, max));
  const x = (v, xloc) => num(xloc === "bar_time" ? timeToIndex(bars, v / 1000) : v);
  const line = (p) => ({ x1: x(p.x1, p.xloc), y1: num(p.y1), x2: x(p.x2, p.xloc), y2: num(p.y2), extend: pick(p.extend, "extend", "none"), color: col(p.color), style: pick(p.style, "lineStyle", "solid"), width: Math.max(1, Math.min(10, Number(p.width) || 1)) });
  const labelY = (p) => {
    if (p.yloc === "abovebar" || p.yloc === "belowbar") {
      const b = bars[Math.round(x(p.x, p.xloc) ?? -1)];
      return b ? (p.yloc === "abovebar" ? b.high : b.low) : null;
    }
    return num(p.y);
  };
  return {
    lines: d.line.map((l) => line(l.p)),
    labels: d.label.map(({ p }) => ({ x: x(p.x, p.xloc), y: labelY(p), yloc: pick(p.yloc, "yloc", "price"), text: txt(p.text), color: col(p.color), textcolor: col(p.textcolor), style: pick(p.style, "labelStyle", "label_down"), size: pick(p.size, "size", "normal"), textalign: pick(p.textalign, "halign", "center") })),
    boxes: d.box.map(({ p }) => ({ left: x(p.left, p.xloc), right: x(p.right, p.xloc), top: num(p.top), bottom: num(p.bottom), border: col(p.border_color), borderWidth: Math.max(0, Math.min(10, Number(p.border_width) || 0)), borderStyle: pick(p.border_style, "lineStyle", "solid"), extend: pick(p.extend, "extend", "none"), bg: col(p.bgcolor), text: txt(p.text), textColor: col(p.text_color), textSize: pick(p.text_size, "size", "auto"), halign: pick(p.text_halign, "halign", "center"), valign: pick(p.text_valign, "valign", "center") })),
    linefills: d.linefill.map(({ p }) => ({ a: line(p.line1.p), b: line(p.line2.p), color: col(p.color) })),
    tables: d.table.map(({ p }) => ({
      position: pick(p.position, "position", "top_right"), columns: p.columns, rows: p.rows, bg: col(p.bgcolor), frame: col(p.frame_color), frameWidth: Math.max(0, Math.min(10, Number(p.frame_width) || 0)), border: col(p.border_color), borderWidth: Math.max(0, Math.min(10, Number(p.border_width) || 0)),
      cells: [...p.cells.values()].map((c) => ({ col: c.column, row: c.row, text: txt(c.text, 1000), color: col(c.text_color), bg: col(c.bgcolor), size: pick(c.text_size, "size", "normal"), halign: pick(c.text_halign, "halign", "center"), valign: pick(c.text_valign, "valign", "center"), width: Math.max(0, Math.min(100, num(c.width) || 0)), height: Math.max(0, Math.min(100, num(c.height) || 0)) })),
      merges: p.merges.map((m) => ({ ...m })),
    })),
  };
};
// A time (seconds) as a bar index: exact, between two bars, or past either end at the last spacing.
function timeToIndex(bars, t) {
  const n = bars.length;
  if (!n || !Number.isFinite(t)) return NA;
  if (n === 1) return 0;
  if (t <= bars[0].time) return (t - bars[0].time) / (bars[1].time - bars[0].time || 1);
  if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / (bars[n - 1].time - bars[n - 2].time || 1);
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time || 1);
}

Runtime.prototype.needStrat = function (nm) {
  if (!this.strat) throw new PineError(`${nm}() is only for strategy() scripts`, this.line);
};
// plotshape/plotchar shapes and places, as the chart's markers.
Runtime.prototype.mark = function (style, location, color, text, offset, plot) {
  const bar = this.bars[this.i + Math.round(Number(offset) || 0)];
  if (!bar) return;
  const below = location === "belowbar" || location === "bottom";
  const shape = /up/.test(style) ? "arrowUp" : /down/.test(style) ? "arrowDown" : style === "square" || style === "diamond" || style === "flag" ? "square" : "circle";
  const m = { time: bar.time, position: location === "absolute" ? "inBar" : below ? "belowBar" : "aboveBar", shape, color: cssColor(color) || (below ? "#089981" : "#f23645") };
  if (text) m.text = String(text);
  if (plot) m.plot = plot;
  this.markers.push(m);
};

// ======================================================================= strategy engine
// TradingView's defaults: market orders placed on a bar's close fill at the next bar's open; price
// orders and exits trigger inside later bars, walking open, the nearer extreme, the far one, close.
class Strategy {
  constructor(o, bars, mintick, ctx = {}) {
    this.bars = bars;
    this.mintick = mintick;
    // the last bar is still forming (live data): on bar close, the script places no orders on it yet
    this.forming = !!ctx.forming;
    // the report's testing period: orders only inside it, and nothing fills after it
    this.from = Number.isFinite(ctx.range?.from) ? ctx.range.from : -Infinity;
    this.to = Number.isFinite(ctx.range?.to) ? ctx.range.to : Infinity;
    this.lastIn = -1;
    this.o = {
      initial_capital: 1000000, default_qty_type: "fixed", default_qty_value: 1, pyramiding: 0, commission_type: "percent", commission_value: 0, slippage: 0, process_orders_on_close: false, close_entries_rule: "FIFO",
      ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(typeof v === "number" && Number.isNaN(v)))),
    };
    this.cash0 = Number(this.o.initial_capital) || 1000000;
    // limit orders fill at their price once the price goes this many ticks past it
    this.limitTicks = Math.max(0, Number(this.o.backtest_fill_limits_assumption) || 0);
    this.realized = 0;
    this.entries = []; // open entries: { id, dir, qty, price, time, index, fee }
    this.market = []; // orders for the next open
    this.pending = []; // limit / stop entries
    this.exits = new Map(); // id and entry -> exit order
    this.trades = [];
    this.equity = [];
    this.marks = [];
    this.allow = "all";
    this.i = 0;
    this.seq = 0; // trade numbers, in entry order
    this.fees = 0;
    this.path = null; // this bar's price path: open, nearer extreme, far extreme, close
    this.seg = 4; // the first point of the path not reached yet (4: the bar has closed)
  }
  get size() {
    return this.entries.reduce((a, e) => a + e.dir * e.qty, 0);
  }
  get avg() {
    const q = this.entries.reduce((a, e) => a + e.qty, 0);
    return q ? this.entries.reduce((a, e) => a + e.qty * e.price, 0) / q : NA;
  }
  openProfit(price) {
    return this.entries.reduce((a, e) => a + e.dir * e.qty * (price - e.price), 0);
  }
  get(k) {
    const close = this.bars[this.i]?.close;
    switch (k) {
      case "position_size":
        return this.size;
      case "position_avg_price":
        return this.avg;
      case "equity":
        return this.cash0 + this.realized + this.openProfit(close);
      case "netprofit":
        return this.realized;
      case "openprofit":
        return this.openProfit(close);
      case "opentrades":
        return this.entries.length;
      case "closedtrades":
        return this.trades.length;
      case "wintrades":
        return this.trades.filter((t) => t.pnl > 0).length;
      case "losstrades":
        return this.trades.filter((t) => t.pnl < 0).length;
      case "eventrades":
        return this.trades.filter((t) => t.pnl === 0).length;
      case "initial_capital":
        return this.cash0;
      case "grossprofit":
        return this.trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
      case "grossloss":
        return -this.trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
      case "max_drawdown":
        return this.maxDd || 0;
      case "position_entry_name":
        return this.entries.at(-1)?.id ?? "";
      default:
        throw new PineError(`strategy.${k} isn't supported here yet`);
    }
  }
  fee(qty, price) {
    const v = Number(this.o.commission_value) || 0;
    if (this.o.commission_type === "cash_per_contract") return qty * v;
    if (this.o.commission_type === "cash_per_order") return v;
    return (qty * price * v) / 100;
  }
  qtyFor(price, qty) {
    if (Number.isFinite(qty) && qty > 0) return qty;
    const v = Number(this.o.default_qty_value) || 1;
    const eq = this.cash0 + this.realized + this.openProfit(price);
    if (this.o.default_qty_type === "cash") return v / price;
    if (this.o.default_qty_type === "percent_of_equity") return (eq * v) / 100 / price;
    return v;
  }
  slip(price, dir) {
    return price + dir * (Number(this.o.slippage) || 0) * this.mintick;
  }
  // Script execution "On bar close": nothing new is ordered from a bar that hasn't closed.
  held() {
    const t = this.bars[this.i]?.time;
    return t < this.from || t > this.to || (this.forming && !this.o.calc_on_every_tick && this.i === this.bars.length - 1);
  }
  // ---- orders from the script
  entry(a) {
    if (this.held()) return;
    const dir = a.direction === "short" || a.direction === false ? -1 : 1;
    if ((this.allow === "long" && dir < 0 && !a.order) || (this.allow === "short" && dir > 0 && !a.order)) {
      if (this.size * dir < 0) this.close(null, a.comment);
      return;
    }
    const order = { id: String(a.id), dir, qty: a.qty, limit: a.limit, stop: a.stop, comment: a.comment, plain: !!a.order };
    if (isNa(order.limit ?? NA) && isNa(order.stop ?? NA)) {
      this.market = this.market.filter((m) => !(m.kind === "entry" && m.id === order.id));
      this.market.push({ kind: "entry", ...order });
      if (this.o.process_orders_on_close) this.fillMarket(this.i, this.bars[this.i].close);
    } else {
      this.pending = this.pending.filter((p) => p.id !== order.id);
      this.pending.push(order);
    }
  }
  close(id, comment, immediately) {
    if (this.held()) return;
    this.market.push({ kind: "close", id: id == null ? null : String(id), comment });
    if (immediately || this.o.process_orders_on_close) this.fillMarket(this.i, this.bars[this.i].close);
  }
  exit(a) {
    if (this.held()) return;
    const id = String(a.id),
      from = a.from_entry == null || a.from_entry === "" ? null : String(a.from_entry);
    // one order per id and entry, as on TradingView: "Exit" from Long and "Exit" from Short both stand
    const key = `${id}\u0000${from ?? ""}`,
      prev = this.exits.get(key);
    this.exits.set(key, {
      id,
      from,
      profit: a.profit,
      loss: a.loss,
      limit: a.limit,
      stop: a.stop,
      trailPoints: a.trail_points,
      trailOffset: a.trail_offset,
      trailPrice: a.trail_price,
      comment: a.comment,
      cProfit: a.comment_profit,
      cLoss: a.comment_loss,
      cTrail: a.comment_trailing,
      placed: this.i,
      // a trailing stop keeps its activation and extreme while the script repeats the call
      trailOn: prev?.trailOn,
      peak: prev?.peak,
    });
  }
  cancel(id) {
    if (this.held()) return;
    if (id == null) {
      this.pending = [];
      this.exits.clear();
      this.market = this.market.filter((m) => m.kind !== "entry");
    } else {
      this.pending = this.pending.filter((p) => p.id !== String(id));
      for (const [k, x] of this.exits) if (x.id === String(id)) this.exits.delete(k);
      this.market = this.market.filter((m) => !(m.kind === "entry" && m.id === String(id)));
    }
  }
  // ---- fills
  openEntry(i, o, price) {
    const max = Math.max(1, Number(this.o.pyramiding) || 0);
    if (this.size * o.dir < 0) this.closeEntries(i, null, price, o.id);
    if (!o.plain && this.entries.filter((e) => e.dir === o.dir).length >= max) return;
    const fill = this.slip(price, o.dir),
      qty = this.qtyFor(fill, o.qty);
    if (!(qty > 0)) return;
    const fee = this.fee(qty, fill);
    this.realized -= fee;
    this.fees += fee;
    this.entries.push({ id: o.id, dir: o.dir, qty, price: fill, time: this.bars[i].time, index: i, fee, comment: o.comment, n: ++this.seq, hi: fill, lo: fill, from: this.seg });
    this.mark(i, o.dir, o.comment || o.id, qty);
  }
  closeEntries(i, which, price, reason) {
    const keep = [];
    for (const e of this.entries) {
      if (which && !which(e)) {
        keep.push(e);
        continue;
      }
      const fill = this.slip(price, -e.dir),
        fee = this.fee(e.qty, fill);
      const pnl = e.dir * e.qty * (fill - e.price) - fee;
      this.realized += e.dir * e.qty * (fill - e.price) - fee;
      this.fees += fee;
      this.seen(e, i, this.seg, fill);
      const ex = this.excursion(e);
      this.trades.push({ n: e.n, side: e.dir > 0 ? "long" : "short", entryTime: e.time, exitTime: this.bars[i].time, entryPrice: e.price, exitPrice: fill, qty: e.qty, pnl: pnl - e.fee, pnlPct: ((pnl - e.fee) / (e.price * e.qty)) * 100, bars: i - e.index + 1, entryReason: e.id, exitReason: reason || "Close", entrySignal: e.comment || e.id, exitSignal: reason || "Close", ...ex });
      this.mark(i, -e.dir, reason || "Close", e.qty);
    }
    const closedIds = new Set(this.entries.filter((e) => !keep.includes(e)).map((e) => e.id));
    this.entries = keep;
    if (!this.entries.length) {
      // brackets tied to the closed entries go with them
      for (const [k, x] of this.exits) if (!x.from || closedIds.has(x.from)) this.exits.delete(k);
    }
  }
  // A buy or sell on the chart: an arrow, the order's name and the signed quantity (Style: Signal labels, Quantity)
  mark(i, dir, signal, qty) {
    const q = `${dir > 0 ? "+" : "\u2212"}${+qty.toPrecision(4)}`;
    this.marks.push({ time: this.bars[i].time, position: dir > 0 ? "belowBar" : "aboveBar", shape: dir > 0 ? "arrowUp" : "arrowDown", color: dir > 0 ? "#2962ff" : "#f23645", text: `${signal} ${q}`, strat: true, signal, qty: q });
  }
  fillMarket(i, price) {
    const orders = this.market;
    this.market = [];
    for (const o of orders) {
      if (o.kind === "close") this.closeEntries(i, o.id == null ? null : (e) => e.id === o.id, price, o.comment || (o.id == null ? "Close all" : `Close ${o.id}`));
      else this.openEntry(i, o, price);
    }
  }
  beforeBar(i) {
    this.i = i;
    const b = this.bars[i];
    if (b.time > this.to) {
      // the testing period is over: nothing fills
      this.path = null;
      this.seg = 4;
      return;
    }
    // open, the nearer extreme, the far one, close (TradingView's assumption inside a bar)
    const path = b.high - b.open < b.open - b.low ? [b.open, b.high, b.low, b.close] : [b.open, b.low, b.high, b.close];
    this.path = path;
    this.seg = 1;
    if (this.market.length) this.fillMarket(i, b.open);
    for (let s = 0; s < path.length; s++) {
      const a = s ? path[s - 1] : path[0],
        z = path[s];
      this.seg = Math.max(1, s);
      let guard = 0;
      for (;;) {
        const hit = this.nextTrigger(i, a, z, s === 0);
        if (!hit || ++guard > 20) break;
        hit.run();
      }
    }
    this.seg = 4;
  }
  // The prices an entry has seen on bar i, up to path point `to` (exclusive), and `also`.
  seen(e, i, to, also) {
    const pts = (this.path || []).slice(e.index === i ? e.from : 0, to);
    if (also != null) pts.push(also);
    if (!pts.length) return;
    e.hi = Math.max(e.hi, ...pts);
    e.lo = Math.min(e.lo, ...pts);
  }
  // A trade's run-up and drawdown: its best and worst unrealized profit, and as % of its size.
  excursion(e) {
    const value = e.price * e.qty || 1,
      runUp = Math.max(0, e.dir > 0 ? (e.hi - e.price) * e.qty : (e.price - e.lo) * e.qty),
      drawdown = Math.max(0, e.dir > 0 ? (e.price - e.lo) * e.qty : (e.hi - e.price) * e.qty);
    return { runUp, runUpPct: (runUp / value) * 100, drawdown, drawdownPct: (drawdown / value) * 100 };
  }
  // The first order the price reaches moving from a to z (at the open: anything already passed).
  nextTrigger(i, a, z, atOpen) {
    const lo = Math.min(a, z),
      hi = Math.max(a, z);
    const reach = (price) => (atOpen ? (price === a ? a : null) : price >= lo && price <= hi ? price : null);
    const cands = [];
    // price entries
    for (const o of this.pending) {
      let at = null;
      if (Number.isFinite(o.limit)) {
        const past = o.limit - o.dir * this.limitTicks * this.mintick;
        at = atOpen ? ((o.dir > 0 && a <= past) || (o.dir < 0 && a >= past) ? (o.dir > 0 ? Math.min(a, o.limit) : Math.max(a, o.limit)) : null) : reach(past) != null ? o.limit : null;
      }
      else if (Number.isFinite(o.stop)) at = atOpen ? ((o.dir > 0 && a >= o.stop) || (o.dir < 0 && a <= o.stop) ? a : null) : reach(o.stop);
      if (at != null)
        cands.push({ at, run: () => {
          this.pending = this.pending.filter((x) => x !== o);
          this.openEntry(i, o, at);
        } });
    }
    // exits on open entries placed before this bar
    for (const x of this.exits.values()) {
      const es = this.entries.filter((e) => (!x.from || e.id === x.from) && e.index < i + 1 && x.placed < i + 1);
      if (!es.length) continue;
      const dir = es[0].dir,
        avg = es.reduce((s, e) => s + e.qty * e.price, 0) / es.reduce((s, e) => s + e.qty, 0);
      const tp = Number.isFinite(x.limit) ? x.limit : Number.isFinite(x.profit) ? avg + dir * x.profit * this.mintick : null;
      let sl = Number.isFinite(x.stop) ? x.stop : Number.isFinite(x.loss) ? avg - dir * x.loss * this.mintick : null;
      // trailing stop: active once price passes the activation level, then follows the extreme
      if (Number.isFinite(x.trailOffset) && (Number.isFinite(x.trailPoints) || Number.isFinite(x.trailPrice))) {
        const act = Number.isFinite(x.trailPrice) ? x.trailPrice : avg + dir * x.trailPoints * this.mintick;
        const best = dir > 0 ? Math.max(a, z) : Math.min(a, z);
        if (!x.trailOn && (dir > 0 ? best >= act : best <= act)) {
          x.trailOn = true;
          x.peak = best;
        }
        if (x.trailOn) {
          x.peak = dir > 0 ? Math.max(x.peak, best) : Math.min(x.peak, best);
          const ts = x.peak - dir * x.trailOffset * this.mintick;
          sl = sl == null ? ts : dir > 0 ? Math.max(sl, ts) : Math.min(sl, ts);
        }
      }
      const which = (e) => es.includes(e);
      if (tp != null) {
        const past = tp + dir * this.limitTicks * this.mintick;
        const at = atOpen ? ((dir > 0 && a >= past) || (dir < 0 && a <= past) ? (dir > 0 ? Math.max(a, tp) : Math.min(a, tp)) : null) : reach(past) != null ? tp : null;
        if (at != null) cands.push({ at, run: () => this.closeEntries(i, which, at, x.cProfit || x.comment || x.id) });
      }
      if (sl != null) {
        const at = atOpen ? ((dir > 0 && a <= sl) || (dir < 0 && a >= sl) ? a : null) : reach(sl);
        if (at != null) cands.push({ at, run: () => this.closeEntries(i, which, at, (x.trailOn ? x.cTrail : x.cLoss) || x.comment || x.id) });
      }
    }
    if (!cands.length) return null;
    cands.sort((p, q) => Math.abs(p.at - a) - Math.abs(q.at - a));
    return cands[0];
  }
  afterBar(i) {
    const b = this.bars[i];
    if (b.time < this.from || b.time > this.to) return;
    this.lastIn = i;
    for (const e of this.entries) this.seen(e, i, 4);
    const base = this.cash0 + this.realized,
      eq = base + this.openProfit(b.close);
    this.peak = Math.max(this.peak ?? eq, eq);
    this.maxDd = Math.max(this.maxDd || 0, this.peak - eq);
    // intrabar, as the report's Max drawdown: the open position at the bar's worst and best prices
    const ops = [b.high, b.low, b.close].map((x) => this.openProfit(x)),
      lo = base + Math.min(...ops),
      pk = this.peakIb ?? this.cash0;
    if (pk - lo > (this.ddIb || 0)) {
      this.ddIb = pk - lo;
      this.ddIbPct = pk > 0 ? ((pk - lo) / pk) * 100 : 0;
    }
    this.peakIb = Math.max(pk, base + Math.max(...ops));
    this.equity.push({ time: b.time, value: eq });
  }
  result() {
    const last = this.lastIn >= 0 ? this.lastIn : this.bars.length - 1;
    const open = this.entries.map((e) => ({ n: e.n, side: e.dir > 0 ? "long" : "short", entryTime: e.time, entryPrice: e.price, qty: e.qty, openProfit: e.dir * e.qty * (this.bars[last].close - e.price) - e.fee, price: this.bars[last].close, bars: last - e.index + 1, entrySignal: e.comment || e.id, ...this.excursion(e) }));
    const commission = Number(this.o.commission_value) || 0;
    const st = stats(this.bars, this.trades, this.equity.length ? this.equity : [{ time: this.bars[0]?.time, value: this.cash0 }], {
      initialCapital: this.cash0,
      feePct: this.o.commission_type === "percent" ? commission : 0,
      slippagePct: 0,
      spreadPct: 0,
    });
    st.feesAndSlippage = `commission ${commission}${this.o.commission_type === "percent" ? "%" : this.o.commission_type === "cash_per_order" ? " per order" : " per contract"}${this.o.slippage ? `, slippage ${this.o.slippage} ticks` : ""}`;
    st.fills = this.o.process_orders_on_close ? "Market orders fill at the bar's close" : "Market orders fill at the next bar's open, as on TradingView";
    const cur = typeof this.o.currency === "string" && this.o.currency !== "NONE" ? this.o.currency : null;
    return { trades: this.trades, open, equity: this.equity, stats: st, marks: this.marks, initialCapital: this.cash0, maxDrawdown: this.maxDd || 0, maxDdIntrabar: this.ddIb || 0, maxDdIntrabarPct: this.ddIbPct || 0, fees: this.fees, currency: cur, opts: { ...this.o } };
  }
}

// ======================================================================= as a chart indicator
// A compiled script as an indicator definition: inputs, outputs (one per plot), levels (hlines)
// and calc(bars, params). The chart's indicator machinery does the rest.
export function pineIndicator(id, compiled, ctxFor = () => ({})) {
  const { meta, inputs, plots, hlines } = compiled;
  const editable = inputs.filter((x) => x.type);
  const outputs = plots
    .filter((p) => p.fn === "plot" && !p.hidden)
    .map((p) => ({ key: p.key, label: p.title, kind: ["histogram", "columns"].includes(p.style) ? "histogram" : "line", color: p.color || "#2962ff", lineWidth: Math.max(1, Math.min(4, Math.round(p.width) || 1)), ...(["circles", "cross"].includes(p.style) ? { dots: true } : {}) }));
  if (!outputs.length) outputs.push({ key: "pnone", label: meta.shorttitle || meta.title, kind: "line", color: "#2962ff" });
  return {
    id,
    name: String(meta.shorttitle || meta.title || "Pine script").slice(0, 80),
    group: "Pine",
    overlay: !!meta.overlay,
    pine: true,
    strategy: meta.kind === "strategy",
    ...(meta.kind === "strategy" ? { strategyOpts: { ...meta.opts }, pineVersion: compiled.version || 6 } : {}),
    inputs: editable.map(({ key, label, type, default: d, options, min, max, step, group, inline, tooltip }) => ({ key, label, type, default: d, ...(options ? { options } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step !== undefined ? { step } : {}), ...(group ? { group } : {}), ...(inline ? { inline } : {}), ...(tooltip ? { tooltip } : {}) })),
    outputs,
    hlines,
    shapes: plots.filter((p) => p.fn !== "plot" && !p.hidden).map((p) => ({ key: p.key, label: p.title, color: p.color || null, fn: p.fn, shape: typeof p.shape === "string" ? p.shape : "xcross", location: p.location === "belowbar" || p.location === "bottom" ? "belowBar" : p.location === "absolute" ? "inBar" : "aboveBar" })),
    objects: compiled.drawsKinds || [],
    calc(bars, params) {
      const r = runPine(compiled, bars, params, params.__ctx || ctxFor());
      const out = { ...r.plots, colorsOf: r.colors };
      if (!out.pnone && outputs[0].key === "pnone") out.pnone = new Array(bars.length).fill(NaN);
      out.markers = [...r.markers, ...(r.strategy?.marks || [])];
      out.pineWarnings = r.warnings;
      if (r.drawings) out.pineDrawings = r.drawings;
      if (r.strategy) out.strategy = r.strategy;
      return out;
    },
  };
}
