# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AST-based JavaScript deobfuscator targeting output from [javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator). Works with any file obfuscated by that tool regardless of the source project.

## Commands

```bash
# Install dependencies
npm install

# Run deobfuscator on a file (outputs <file>.deobf.js)
node deobfuscate.mjs <file.js>
```

No test suite or linter is configured.

## Architecture

Single-file tool (`deobfuscate.mjs`, ~1300 lines) that operates in 3 sequential phases:

**Phase 1 — String Decoding:** Finds the obfuscator's string array function, rotation IIFE, and decoder functions by heuristics (hex names `_0x...`, `charCodeAt`/`fromCharCode` signatures). Executes them in a `vm.createContext` sandbox, then resolves all decoder/wrapper calls to literal strings. Wrapper detection is iterative — wrappers can chain through other wrappers.

**Phase 2 — Structural Cleanup (iterative until convergence):** Runs multiple AST passes in a loop: constant arithmetic folding, boolean coercion (`!![]` → `true`), proxy object inlining, dead branch elimination (string comparisons that are always true/false), unreachable code removal, comma expression splitting, dead numeric object removal, and unused proxy declaration removal. Order matters — proxy inlining creates new string comparisons that enable dead branch removal, which then exposes more dead proxies.

**Phase 3 — Variable Renaming:** Renames `_0x...` identifiers using context inference (DOM APIs, constructors, `fetch`/`json` patterns, callback params) with fallback to sequential `_a`, `_b`, `_c`.

All AST manipulation uses acorn (parse), acorn-walk (traverse), and escodegen (generate). The tool parses once, mutates the AST in-place across phases, and generates output once at the end.

## Key Files

- `deobfuscate.mjs` — the complete deobfuscator
