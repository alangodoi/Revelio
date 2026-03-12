# Revelio ✨

> *"Revelio" — the revealing charm. Because obfuscated code should have nowhere to hide.*

**The only deobfuscator that achieves 100% string recovery on `javascript-obfuscator` output — including RC4-encoded string arrays.**

Most deobfuscators fail when `stringArrayEncoding` is set to `rc4` or `base64` because they try to reverse the encoding statically. Revelio doesn't reverse it — it **executes the original decoder in a sandboxed VM** and lets the obfuscator undo its own work.

---

## Before / After

**Before**
```js
const _0x2e3f = _0x2011(0x1e3, 'k1@K');
if (_0x4cac(0x2a1, 'Xm#9') === _0x4cac(0x1b7, 'Pq$2')) {
  _0x5fab[_0x2011(0x1f4, 'j@K1')](_0x2011(0x20c, 'Lm&8'));
}
```

**After**
```js
const message = 'Solicitando permissao...';
if ('development' === 'production') {
  console.warn('debug mode active');
}
```

---

## How It Works

Revelio operates in **3 phases**, each building on the last.

### Phase 1 — String Decoding

The hardest part. Handles RC4 and base64 string array encoding end-to-end:

1. Detects the string array (`_0x1e6a`, `_0x4cac`, etc.) and its rotation IIFE
2. Identifies decoder functions and nested wrappers (multiple levels deep)
3. **Executes the original decoders inside a sandboxed `vm` context** — no reimplementation, no guessing
4. Replaces every decoder call with the recovered literal string

This is why it works where others don't: if the obfuscator can decode it, so can Revelio.

### Phase 2 — Structural Cleanup

Removes the scaffolding left behind after string decoding. Runs **iteratively until convergence** — each pass exposes patterns for the next.

| Pass | What it does | Example |
|------|-------------|---------|
| 2.1 Arithmetic | Resolves constant expressions | `-1 * 8831 + 93 * -9 + 11668` → `2000` |
| 2.2 Booleans | Resolves boolean coercion | `!![]` → `true`, `![]` → `false` |
| 2.3 Proxy Objects | Inlines delegate objects | `obj.func(a, b)` → `a === b` |
| 2.4 Dead Branches | Eliminates always-true/false conditionals | `if ('abc' !== 'abc') { dead }` → removed |
| 2.4b Unreachable | Removes code after `return`/`throw` | — |
| 2.5 Comma Split | Splits comma expressions into statements | `a = 1, b = 2` → two statements |
| 2.6 Dead Objects | Removes unused numeric objects | `const _0x = { _0xabc: 123 }` → removed |
| 2.7 Dead Proxies | Removes unused proxy declarations | — |

> Iterative convergence matters: proxy inlining creates string comparisons → dead branch removal resolves them → exposes dead proxies → removes their declarations → exposes more proxies. One pass isn't enough.

### Phase 3 — Variable Renaming

Renames `_0x...` identifiers to human-readable names inferred from context.

| Context | Result |
|---------|--------|
| `document.getElementById('status')` | `statusEl` |
| `document.createElement('div')` | `divEl` |
| `new FileReader()` | `fileReader` |
| `new TextEncoder()` | `textEncoder` |
| `await fetch(...)` | `response` |
| `await response.json()` | `data` |
| `catch(e)` | `err` |
| `.map(x => ...)` | `item` |
| `new Promise((a, b) => ...)` | `resolve`, `reject` |
| everything else | `_a`, `_b`, `_c`, … |

---

## Supported Patterns

- ✅ String array with rotation
- ✅ RC4 and base64 string encoding
- ✅ Decoder functions and nested wrappers (multiple levels)
- ✅ Proxy / delegate objects (literals and functions)
- ✅ Dead code insertion (always-true/false conditionals)
- ✅ Comma expressions
- ✅ Numeric flow control objects
- ✅ Proxy object aliases

---

## Installation

```bash
git clone https://github.com/alangodoi/revelio
cd revelio
npm install
```

## Usage

```bash
node deobfuscate.mjs <file.js>
```

The cleaned file is saved as `<file>.deobf.js` alongside the original.

### Examples

```bash
# Single file
node deobfuscate.mjs content.js

# Multiple files
for f in security.js license.js content.js; do
  node deobfuscate.mjs "$f"
done

# File from another project
node deobfuscate.mjs /path/to/obfuscated.js
```

---

## Requirements

- Node.js ≥ 18

## Dependencies

| Package | Role |
|---------|------|
| [acorn](https://github.com/acornjs/acorn) | JavaScript parser → AST |
| [acorn-walk](https://github.com/acornjs/acorn/tree/master/acorn-walk) | AST traversal |
| [escodegen](https://github.com/estools/escodegen) | AST → clean JavaScript |

---

## License

MIT © [Alan Godoi da Silveira](https://github.com/alangodoi)