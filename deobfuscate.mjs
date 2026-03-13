/**
 * Custom deobfuscator for javascript-obfuscator with RC4 string encoding.
 * Handles: string array, rotation, decoders, wrapper functions with local const objects,
 * nested wrappers, and inline object property references.
 */

import { readFileSync, writeFileSync } from 'fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import * as escodegen from 'escodegen';
import vm from 'vm';

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: node deobfuscate.mjs <file.js>');
  process.exit(1);
}

const code = readFileSync(inputFile, 'utf-8');
const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });

// ---- Step 1: Find infrastructure ----

let stringArrayFuncName = null;
let stringArrayFuncNode = null;

// Find the string array function: 0 params, contains a large array of short encoded strings
// Prefer functions with hex-style names (_0x...) and many string entries
let bestScore = 0;
for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration' && node.id && node.params.length === 0) {
    const src = code.slice(node.start, node.end);
    if (!src.includes('[') || !src.includes("'") || !src.includes('return')) continue;

    // Count short string literals in array
    const shortStrings = (src.match(/'[^']{1,30}'/g) || []).length;
    // Prefer hex-named functions
    const isHexName = node.id.name.startsWith('_0x');
    const score = shortStrings * (isHexName ? 2 : 1);

    if (score > bestScore) {
      bestScore = score;
      stringArrayFuncName = node.id.name;
      stringArrayFuncNode = node;
    }
  }
}

let rotationNode = null;
for (const node of ast.body) {
  if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
    const src = code.slice(node.start, node.end);
    if (src.includes('push') && src.includes('shift') && src.includes('parseInt')) {
      rotationNode = node;
      break;
    }
  }
}

const decoderFuncs = {};
for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration' && node.id && node.params.length === 2 && node.id.name !== stringArrayFuncName) {
    const src = code.slice(node.start, node.end);
    if (src.includes(stringArrayFuncName) && (src.includes('charCodeAt') || src.includes('fromCharCode'))) {
      decoderFuncs[node.id.name] = node;
    }
  }
}

console.log(`String array: ${stringArrayFuncName}`);
console.log(`Decoders: ${Object.keys(decoderFuncs).join(', ')}`);

// ---- Step 2: Execute infrastructure in VM ----

if (!stringArrayFuncNode) {
  console.log('No string array infrastructure found — skipping Phase 1 (string decoding).');
}

const infraParts = [];
if (stringArrayFuncNode) infraParts.push(code.slice(stringArrayFuncNode.start, stringArrayFuncNode.end));
if (rotationNode) infraParts.push(code.slice(rotationNode.start, rotationNode.end));
for (const [, node] of Object.entries(decoderFuncs)) {
  infraParts.push(code.slice(node.start, node.end));
}

let decoderNames;
let wrapperFuncs;

if (stringArrayFuncNode) {

const vmContext = vm.createContext({
  console, parseInt, String, decodeURIComponent,
  encodeURIComponent, isNaN, isFinite, undefined,
  NaN, Infinity, Math, Array, Object, RegExp,
  Error, TypeError, RangeError
});

vm.runInContext(infraParts.join('\n'), vmContext, { timeout: 15000 });
console.log('VM ready');

decoderNames = new Set(Object.keys(decoderFuncs));

// ---- Step 3: Collect ALL const object literals throughout the AST ----
// Maps variable name -> { prop: value } for simple numeric/string const objects

const constObjects = new Map();

function collectConstObjects(node) {
  if (!node) return;

  const declarations = [];

  if (node.type === 'VariableDeclaration') {
    declarations.push(...node.declarations);
  }

  for (const decl of declarations) {
    if (decl.id && decl.id.type === 'Identifier' && decl.init && decl.init.type === 'ObjectExpression') {
      const obj = {};
      let allSimple = true;
      for (const prop of decl.init.properties) {
        if (prop.type !== 'Property') { allSimple = false; continue; }
        const key = prop.key.type === 'Identifier' ? prop.key.name :
                    prop.key.type === 'Literal' ? String(prop.key.value) : null;
        if (!key) { allSimple = false; continue; }

        if (prop.value.type === 'Literal') {
          obj[key] = prop.value.value;
        } else if (prop.value.type === 'UnaryExpression' && prop.value.operator === '-' && prop.value.argument.type === 'Literal') {
          obj[key] = -prop.value.argument.value;
        } else if (prop.value.type === 'FunctionExpression') {
          // Skip function props for now, they're not simple values
          obj[key] = { __func: true, node: prop.value };
        } else {
          // Try to evaluate
          const val = safeEval(prop.value);
          if (val !== undefined) {
            obj[key] = val;
          }
        }
      }
      constObjects.set(decl.id.name, obj);
    }
  }
}

function safeEval(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'UnaryExpression') {
    const a = safeEval(node.argument);
    if (a === undefined) return undefined;
    if (node.operator === '-') return -a;
    if (node.operator === '+') return +a;
    if (node.operator === '!') return !a;
  }
  if (node.type === 'BinaryExpression') {
    const l = safeEval(node.left);
    const r = safeEval(node.right);
    if (l === undefined || r === undefined) return undefined;
    switch (node.operator) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
      case '%': return l % r;
    }
  }
  if (node.type === 'MemberExpression' && !node.computed &&
      node.object.type === 'Identifier' && node.property.type === 'Identifier') {
    const obj = constObjects.get(node.object.name);
    if (obj && obj[node.property.name] !== undefined && typeof obj[node.property.name] !== 'object') {
      return obj[node.property.name];
    }
  }
  return undefined;
}

// Walk entire AST to collect all const objects
walk.simple(ast, {
  VariableDeclaration(node) { collectConstObjects(node); }
});

console.log(`Collected ${constObjects.size} const objects`);

// ---- Step 4: Find wrapper functions ----
// A wrapper is: function with N params, body has optional const decls + return decoderCall(...)
// The return call arguments may reference the function params, local consts, or parent scope consts

wrapperFuncs = new Map();

function analyzeWrapper(funcNode) {
  if (!funcNode.id || funcNode.params.length < 2) return null;
  if (decoderNames.has(funcNode.id.name) || funcNode.id.name === stringArrayFuncName) return null;
  if (wrapperFuncs.has(funcNode.id.name)) return null;

  const body = funcNode.body.body;
  if (!body || body.length === 0 || body.length > 5) return null;

  // Collect local const objects from this function
  const localConsts = new Map();
  let returnStmt = null;

  for (const stmt of body) {
    if (stmt.type === 'EmptyStatement') continue;
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id.type === 'Identifier' && decl.init) {
          if (decl.init.type === 'ObjectExpression') {
            const obj = {};
            for (const prop of decl.init.properties) {
              if (prop.type !== 'Property') continue;
              const key = prop.key.type === 'Identifier' ? prop.key.name :
                          prop.key.type === 'Literal' ? String(prop.key.value) : null;
              if (key && prop.value.type === 'Literal') {
                obj[key] = prop.value.value;
              }
            }
            localConsts.set(decl.id.name, obj);
            // Also add to global constObjects for nested resolution
            constObjects.set(decl.id.name, obj);
          } else if (decl.init.type === 'Literal') {
            localConsts.set(decl.id.name, decl.init.value);
          }
        }
      }
    } else if (stmt.type === 'ReturnStatement') {
      returnStmt = stmt;
    } else {
      return null; // unexpected statement
    }
  }

  if (!returnStmt || !returnStmt.argument || returnStmt.argument.type !== 'CallExpression') return null;

  const call = returnStmt.argument;
  if (call.callee.type !== 'Identifier') return null;

  const targetName = call.callee.name;
  if (!decoderNames.has(targetName) && !wrapperFuncs.has(targetName)) return null;

  return {
    name: funcNode.id.name,
    targetFunc: targetName,
    params: funcNode.params.map(p => p.name),
    args: call.arguments,
    localConsts,
    node: funcNode
  };
}

// Collect all function declarations
const allFuncDecls = [];
walk.simple(ast, {
  FunctionDeclaration(node) { allFuncDecls.push(node); }
});

// Multi-pass
let pass = 0;
let foundNew = true;
while (foundNew && pass < 20) {
  foundNew = false;
  pass++;
  for (const funcNode of allFuncDecls) {
    if (!funcNode.id) continue;
    if (wrapperFuncs.has(funcNode.id.name)) continue;
    if (decoderNames.has(funcNode.id.name)) continue;
    if (funcNode.id.name === stringArrayFuncName) continue;

    const info = analyzeWrapper(funcNode);
    if (info) {
      wrapperFuncs.set(info.name, info);
      foundNew = true;
    }
  }
}

console.log(`Found ${wrapperFuncs.size} wrapper functions (${pass} passes)`);

// ---- Step 5: Resolve a call to a wrapper/decoder ----

function evalExpr(node, scope = {}) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;

  if (node.type === 'Identifier') {
    if (node.name in scope) return scope[node.name];
    return undefined;
  }

  if (node.type === 'UnaryExpression') {
    const a = evalExpr(node.argument, scope);
    if (a === undefined) return undefined;
    if (node.operator === '-') return -a;
    if (node.operator === '+') return +a;
    if (node.operator === '!') return !a;
    if (node.operator === '~') return ~a;
  }

  if (node.type === 'BinaryExpression') {
    const l = evalExpr(node.left, scope);
    const r = evalExpr(node.right, scope);
    if (l === undefined || r === undefined) return undefined;
    switch (node.operator) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
      case '%': return l % r;
      case '|': return l | r;
      case '&': return l & r;
      case '^': return l ^ r;
      case '<<': return l << r;
      case '>>': return l >> r;
      case '>>>': return l >>> r;
    }
  }

  if (node.type === 'MemberExpression' && !node.computed &&
      node.object.type === 'Identifier' && node.property.type === 'Identifier') {
    // Check scope first
    if (node.object.name in scope && typeof scope[node.object.name] === 'object') {
      const val = scope[node.object.name][node.property.name];
      if (val !== undefined && typeof val !== 'object') return val;
    }
    // Then global const objects
    const obj = constObjects.get(node.object.name);
    if (obj) {
      const val = obj[node.property.name];
      if (val !== undefined && typeof val !== 'object') return val;
    }
  }

  return undefined;
}

let debugFailures = 0;
function resolveCall(callNode, extraScope = {}, depth = 0) {
  if (depth > 10) return null;
  if (!callNode || callNode.type !== 'CallExpression' || !callNode.callee || callNode.callee.type !== 'Identifier') return null;

  const funcName = callNode.callee.name;

  // Direct decoder call
  if (decoderNames.has(funcName)) {
    const args = callNode.arguments.map(a => evalExpr(a, extraScope));
    if (args.some(a => a === undefined)) {
      if (debugFailures < 5) console.log(`  FAIL decoder args [${funcName}]:`, args);
      debugFailures++;
      return null;
    }
    try {
      const expr = `${funcName}(${args.map(a => typeof a === 'string' ? JSON.stringify(a) : a).join(',')})`;
      return vm.runInContext(expr, vmContext, { timeout: 500 });
    } catch { return null; }
  }

  // Wrapper call
  const wrapper = wrapperFuncs.get(funcName);
  if (!wrapper) {
    if (debugFailures < 5) console.log(`  FAIL not a wrapper: ${funcName}`);
    debugFailures++;
    return null;
  }

  const argValues = callNode.arguments.map(a => evalExpr(a, extraScope));

  // Build scope: wrapper params + local consts
  const scope = {};
  for (let i = 0; i < wrapper.params.length && i < argValues.length; i++) {
    scope[wrapper.params[i]] = argValues[i];
  }
  // Add local consts to scope
  for (const [name, val] of wrapper.localConsts) {
    if (typeof val === 'object' && val !== null) {
      scope[name] = val;
    } else {
      scope[name] = val;
    }
  }

  // Evaluate inner call args - allow undefined for unused params in the chain
  const innerArgs = wrapper.args.map(a => evalExpr(a, scope));

  const targetName = wrapper.targetFunc;

  if (decoderNames.has(targetName)) {
    // For direct decoder calls, all args must be defined
    if (innerArgs.some(a => a === undefined)) {
      if (debugFailures < 5) console.log(`  FAIL decoder args via ${funcName} -> ${targetName}:`, innerArgs);
      debugFailures++;
      return null;
    }
    try {
      const expr = `${targetName}(${innerArgs.map(a => typeof a === 'string' ? JSON.stringify(a) : a).join(',')})`;
      return vm.runInContext(expr, vmContext, { timeout: 500 });
    } catch { return null; }
  }

  // Chain to another wrapper - pass through even with some undefined args
  // The next wrapper will only use the args it needs
  return resolveCall({
    type: 'CallExpression',
    callee: { type: 'Identifier', name: targetName },
    arguments: innerArgs.map(v => v === undefined ? { type: 'Identifier', name: 'undefined' } : { type: 'Literal', value: v })
  }, {}, depth + 1);
}

// ---- Step 6: Replace all string-encoded calls ----
// Collect ranges of wrapper function bodies so we skip calls inside them
const wrapperRanges = [];
for (const [, w] of wrapperFuncs) {
  wrapperRanges.push({ start: w.node.start, end: w.node.end });
}
// Also skip decoder function bodies
for (const [, d] of Object.entries(decoderFuncs)) {
  wrapperRanges.push({ start: d.start, end: d.end });
}

function isInsideWrapper(nodeStart) {
  return wrapperRanges.some(r => nodeStart >= r.start && nodeStart <= r.end);
}

let replacements = 0;
let failures = 0;
const targetNames = new Set([...decoderNames, ...wrapperFuncs.keys()]);

// First pass: resolve and replace string calls in object property values
walk.simple(ast, {
  Property(node) {
    if (node.value && node.value.type === 'CallExpression' &&
        node.value.callee && node.value.callee.type === 'Identifier' &&
        targetNames.has(node.value.callee.name)) {
      const resolved = resolveCall(node.value);
      if (resolved !== null && typeof resolved === 'string') {
        node.value = { type: 'Literal', value: resolved, raw: JSON.stringify(resolved) };
        replacements++;
        // Update constObjects if this property belongs to a tracked object
      }
    }
  }
});

// Also handle string concatenation: _0xWrapper(...) + _0xWrapper(...) + 'literal'
function resolveStringConcat(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier' && targetNames.has(node.callee.name)) {
    return resolveCall(node);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = resolveStringConcat(node.left);
    const r = resolveStringConcat(node.right);
    if (l !== null && r !== null && typeof l === 'string' && typeof r === 'string') return l + r;
  }
  return null;
}

// Second pass: replace all remaining calls
walk.simple(ast, {
  CallExpression(node) {
    // Skip calls inside wrapper/decoder function bodies
    if (node.start !== undefined && isInsideWrapper(node.start)) return;

    if (node.callee && node.callee.type === 'Identifier' && targetNames.has(node.callee.name)) {
      const resolved = resolveCall(node);
      if (resolved !== null && typeof resolved === 'string') {
        node.type = 'Literal';
        node.value = resolved;
        node.raw = JSON.stringify(resolved);
        delete node.callee;
        delete node.arguments;
        delete node.optional;
        replacements++;
      } else {
        if (failures < 3) {
          const argSrcs = node.arguments.map(a => code.slice(a.start, a.end).slice(0,50));
          console.log(`  CALL FAIL: ${node.callee.name}(${argSrcs.join(', ')})`);
          // Check if caller args resolve
          const argVals = node.arguments.map(a => evalExpr(a));
          console.log(`    arg vals:`, argVals);
        }
        failures++;
      }
    }
  }
});

// Third pass: resolve string concatenations
walk.simple(ast, {
  BinaryExpression(node) {
    if (node.operator === '+') {
      const result = resolveStringConcat(node);
      if (result !== null && typeof result === 'string') {
        node.type = 'Literal';
        node.value = result;
        node.raw = JSON.stringify(result);
        delete node.left;
        delete node.right;
        delete node.operator;
        replacements++;
      }
    }
  }
});

// Fourth pass: resolve inline object member expressions with string values
// obj['method'] -> obj.method
walk.simple(ast, {
  MemberExpression(node) {
    if (node.computed && node.property && node.property.type === 'Literal' &&
        typeof node.property.value === 'string' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(node.property.value)) {
      node.computed = false;
      node.property = { type: 'Identifier', name: node.property.value };
    }
  }
});

// Fifth pass: inline const object property lookups where value is a simple literal
// e.g., _0x54beda['ZTgct'] where _0x54beda.ZTgct = 'permissions'
walk.simple(ast, {
  MemberExpression(node) {
    if (!node.computed && node.object.type === 'Identifier' && node.property.type === 'Identifier') {
      const obj = constObjects.get(node.object.name);
      if (obj) {
        const val = obj[node.property.name];
        if (typeof val === 'string' || typeof val === 'number') {
          node.type = 'Literal';
          node.value = val;
          node.raw = JSON.stringify(val);
          delete node.object;
          delete node.property;
          delete node.computed;
          delete node.optional;
        }
      }
    }
  }
});

console.log(`\nReplacements: ${replacements}, Failures: ${failures}`);

// ---- Step 7: Remove dead infrastructure ----
// Remove: string array function, rotation IIFE, decoder functions, top-level wrapper functions

const deadNames = new Set([stringArrayFuncName, ...decoderNames]);
// Only remove top-level wrappers
for (const node of ast.body) {
  if (node.type === 'FunctionDeclaration' && node.id && wrapperFuncs.has(node.id.name)) {
    deadNames.add(node.id.name);
  }
}

ast.body = ast.body.filter(node => {
  if (node === rotationNode) return false;
  if (node.type === 'FunctionDeclaration' && node.id && deadNames.has(node.id.name)) return false;
  return true;
});

// Remove nested wrapper functions and their associated const objects from function bodies
const wrapperNames = new Set(wrapperFuncs.keys());
let removedNested = 0;

function cleanBlockBody(body) {
  if (!Array.isArray(body)) return;
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i];
    // Remove nested wrapper function declarations
    if (stmt.type === 'FunctionDeclaration' && stmt.id && wrapperNames.has(stmt.id.name)) {
      body.splice(i, 1);
      removedNested++;
      continue;
    }
    // Remove const objects that only contain numeric/string values used by wrappers
    // (the _0x38d670-style objects with numeric values)
    if (stmt.type === 'VariableDeclaration') {
      stmt.declarations = stmt.declarations.filter(decl => {
        if (!decl.id || decl.id.type !== 'Identifier') return true;
        if (!decl.init || decl.init.type !== 'ObjectExpression') return true;
        // Check if ALL properties are simple numeric/string literals (wrapper arg objects)
        const props = decl.init.properties;
        if (props.length === 0) return true;
        const allSimple = props.every(p => {
          if (p.type !== 'Property') return false;
          if (p.key.type !== 'Identifier' || !p.key.name.startsWith('_0x')) return false;
          return p.value.type === 'Literal' && (typeof p.value.value === 'number' || typeof p.value.value === 'string');
        });
        if (allSimple && props.length > 2) {
          removedNested++;
          return false; // remove this declarator
        }
        return true;
      });
      // Remove empty declarations
      if (stmt.declarations.length === 0) {
        body.splice(i, 1);
        continue;
      }
    }
    // Recurse into blocks
    if (stmt.body) {
      if (Array.isArray(stmt.body)) cleanBlockBody(stmt.body);
      else if (stmt.body.body) cleanBlockBody(stmt.body.body);
    }
    if (stmt.consequent) {
      if (stmt.consequent.body) cleanBlockBody(stmt.consequent.body);
    }
    if (stmt.alternate) {
      if (stmt.alternate.body) cleanBlockBody(stmt.alternate.body);
    }
    if (stmt.block && stmt.block.body) cleanBlockBody(stmt.block.body);
    if (stmt.handler && stmt.handler.body && stmt.handler.body.body) cleanBlockBody(stmt.handler.body.body);
    if (stmt.finalizer && stmt.finalizer.body) cleanBlockBody(stmt.finalizer.body);
  }
}

// Walk all function bodies
walk.simple(ast, {
  FunctionDeclaration(node) { if (node.body && node.body.body) cleanBlockBody(node.body.body); },
  FunctionExpression(node) { if (node.body && node.body.body) cleanBlockBody(node.body.body); },
  ArrowFunctionExpression(node) { if (node.body && node.body.body) cleanBlockBody(node.body.body); }
});

console.log(`Removed ${removedNested} nested dead nodes`);

} else {
  // No string array infrastructure — skip Phase 1
  decoderNames = new Set();
  wrapperFuncs = new Map();
}

// ======== Phase 2: Structural Cleanup (iterative convergence) ========
console.log('\n=== Phase 2: Structural Cleanup ===');

// Helper: evaluate a node as a pure numeric expression (no variable references)
function evalNumeric(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node.type === 'UnaryExpression') {
    const arg = evalNumeric(node.argument);
    if (arg === undefined) return undefined;
    if (node.operator === '-') return -arg;
    if (node.operator === '+') return +arg;
    if (node.operator === '~') return ~arg;
  }
  if (node.type === 'BinaryExpression') {
    const l = evalNumeric(node.left);
    const r = evalNumeric(node.right);
    if (l === undefined || r === undefined) return undefined;
    switch (node.operator) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return r !== 0 ? l / r : undefined;
      case '%': return r !== 0 ? l % r : undefined;
      case '|': return l | r;
      case '&': return l & r;
      case '^': return l ^ r;
      case '<<': return l << r;
      case '>>': return l >> r;
      case '>>>': return l >>> r;
    }
  }
  return undefined;
}

function replaceWithLiteral(node, val) {
  const keys = Object.keys(node);
  keys.forEach(k => { if (k !== 'start' && k !== 'end') delete node[k]; });
  if (typeof val === 'number' && val < 0) {
    node.type = 'UnaryExpression';
    node.operator = '-';
    node.prefix = true;
    node.argument = { type: 'Literal', value: -val, raw: String(-val) };
  } else {
    node.type = 'Literal';
    node.value = val;
    node.raw = typeof val === 'string' ? JSON.stringify(val) : String(val);
  }
}

function evalCondition(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') {
    if (typeof node.value === 'boolean') return node.value;
    if (typeof node.value === 'string') return node.value.length > 0;
    if (typeof node.value === 'number') return node.value !== 0;
    return undefined;
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const inner = evalCondition(node.argument);
    if (inner !== undefined) return !inner;
  }
  if (node.type === 'BinaryExpression') {
    if (node.left.type === 'Literal' && node.right.type === 'Literal') {
      const l = node.left.value, r = node.right.value;
      switch (node.operator) {
        case '===': return l === r;
        case '!==': return l !== r;
        case '==': return l == r;
        case '!=': return l != r;
      }
    }
  }
  return undefined;
}

// Analyze a FunctionExpression to see if it's a simple proxy
function analyzeFuncProxy(funcNode) {
  if (!funcNode.body || !funcNode.body.body) return null;
  const body = funcNode.body.body;
  if (body.length !== 1 || body[0].type !== 'ReturnStatement') return null;
  const ret = body[0].argument;
  if (!ret) return null;
  const params = funcNode.params.map(p => p.type === 'Identifier' ? p.name : null);
  if (params.some(p => p === null)) return null;

  // Binary/logical: function(a, b) { return a OP b; }
  if ((ret.type === 'BinaryExpression' || ret.type === 'LogicalExpression') &&
      ret.left.type === 'Identifier' && ret.right.type === 'Identifier') {
    const li = params.indexOf(ret.left.name);
    const ri = params.indexOf(ret.right.name);
    if (li >= 0 && ri >= 0) {
      return { kind: 'binary', operator: ret.operator, leftIdx: li, rightIdx: ri,
               exprType: ret.type === 'LogicalExpression' ? 'LogicalExpression' : 'BinaryExpression' };
    }
  }

  // Function call: function(a, b, c) { return a(b, c); }
  if (ret.type === 'CallExpression' && ret.callee.type === 'Identifier') {
    const ci = params.indexOf(ret.callee.name);
    if (ci >= 0) {
      const argIdxs = ret.arguments.map(a =>
        a.type === 'Identifier' ? params.indexOf(a.name) : -1
      );
      if (argIdxs.every(i => i >= 0)) {
        return { kind: 'call', callerIdx: ci, argIdxs };
      }
    }
  }

  return null;
}

// Helper: recurse into all statement body arrays
function forEachBody(body, fn) {
  if (!Array.isArray(body)) return;
  fn(body);
  for (const stmt of body) {
    if (stmt.type === 'FunctionDeclaration' || stmt.type === 'FunctionExpression') {
      if (stmt.body && stmt.body.body) forEachBody(stmt.body.body, fn);
    }
    if (stmt.type === 'IfStatement') {
      if (stmt.consequent && stmt.consequent.type === 'BlockStatement') forEachBody(stmt.consequent.body, fn);
      if (stmt.alternate && stmt.alternate.type === 'BlockStatement') forEachBody(stmt.alternate.body, fn);
      if (stmt.alternate && stmt.alternate.type === 'IfStatement') forEachBody([stmt.alternate], fn);
    }
    if (stmt.type === 'ForStatement' || stmt.type === 'WhileStatement' || stmt.type === 'DoWhileStatement' ||
        stmt.type === 'ForOfStatement' || stmt.type === 'ForInStatement') {
      if (stmt.body && stmt.body.type === 'BlockStatement') forEachBody(stmt.body.body, fn);
    }
    if (stmt.type === 'TryStatement') {
      if (stmt.block && stmt.block.body) forEachBody(stmt.block.body, fn);
      if (stmt.handler && stmt.handler.body && stmt.handler.body.body) forEachBody(stmt.handler.body.body, fn);
      if (stmt.finalizer && stmt.finalizer.body) forEachBody(stmt.finalizer.body, fn);
    }
    if (stmt.type === 'SwitchStatement') {
      for (const c of stmt.cases || []) {
        if (c.consequent) forEachBody(c.consequent, fn);
      }
    }
  }
}

// Apply a body-level function to all scopes via walk.simple + top-level
function applyToAllScopes(fn) {
  walk.simple(ast, {
    FunctionDeclaration(node) { if (node.body && node.body.body) fn(node.body.body); },
    FunctionExpression(node) { if (node.body && node.body.body) fn(node.body.body); },
    ArrowFunctionExpression(node) { if (node.body && node.body.body) fn(node.body.body); }
  });
  fn(ast.body);
}

// ---- Totals across all iterations ----
let totalArithmetic = 0, totalBooleans = 0, totalProxyInlined = 0;
let totalDeadBranches = 0, totalUnreachable = 0, totalCommasSplit = 0;
let totalDeadObjects = 0, totalProxyDeclsRemoved = 0, totalDeadProxies = 0;

const MAX_ITERATIONS = 15;

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  let iterChanges = 0;
  console.log(`\n  --- Iteration ${iteration} ---`);

  // --- Pass 2.1: Evaluate constant arithmetic ---
  let arithmeticCount = 0;
  walk.simple(ast, {
    BinaryExpression(node) {
      const val = evalNumeric(node);
      if (val !== undefined && isFinite(val) && Number.isInteger(val)) {
        replaceWithLiteral(node, val);
        arithmeticCount++;
      }
    }
  });
  totalArithmetic += arithmeticCount;
  iterChanges += arithmeticCount;
  if (arithmeticCount) console.log(`    Arithmetic resolved: ${arithmeticCount}`);

  // --- Pass 2.2: Boolean coercion ---
  let booleanCount = 0;
  walk.simple(ast, {
    UnaryExpression(node) {
      if (node.operator !== '!') return;
      const arg = node.argument;
      let val;
      if (arg.type === 'ArrayExpression' && arg.elements.length === 0) {
        val = false;
      } else if (arg.type === 'Literal' && typeof arg.value === 'boolean') {
        val = !arg.value;
      }
      if (val !== undefined) {
        replaceWithLiteral(node, val);
        booleanCount++;
      }
    }
  });
  totalBooleans += booleanCount;
  iterChanges += booleanCount;
  if (booleanCount) console.log(`    Booleans resolved: ${booleanCount}`);

  // --- Pass 2.3: Collect and inline proxy objects ---
  const proxyObjects = new Map();

  // Collect from VariableDeclarations with ObjectExpression inits
  walk.simple(ast, {
    VariableDeclaration(node) {
      for (const decl of node.declarations) {
        if (!decl.id || decl.id.type !== 'Identifier' || !decl.init) continue;
        if (decl.init.type !== 'ObjectExpression') continue;

        const props = decl.init.properties;
        const obj = {};
        let hasProxy = false;

        for (const prop of props) {
          if (prop.type !== 'Property') continue;
          const key = prop.key.type === 'Identifier' ? prop.key.name :
                      prop.key.type === 'Literal' ? String(prop.key.value) : null;
          if (!key) continue;

          if (prop.value.type === 'Literal') {
            obj[key] = { kind: 'literal', value: prop.value.value };
            hasProxy = true;
          } else if (prop.value.type === 'FunctionExpression' || prop.value.type === 'ArrowFunctionExpression') {
            const fp = analyzeFuncProxy(prop.value);
            if (fp) { obj[key] = fp; hasProxy = true; }
          }
        }

        if (hasProxy) proxyObjects.set(decl.id.name, obj);
      }
    }
  });

  // Collect incrementally-built proxy objects: const x = {}; x.prop = val;
  function collectIncrementalProxies(body) {
    if (!Array.isArray(body)) return;

    const emptyObjs = new Map();
    for (const stmt of body) {
      if (stmt.type === 'VariableDeclaration') {
        for (const decl of stmt.declarations) {
          if (decl.id && decl.id.type === 'Identifier' && decl.init &&
              decl.init.type === 'ObjectExpression' && decl.init.properties.length === 0) {
            emptyObjs.set(decl.id.name, {});
          }
        }
      }
    }
    if (emptyObjs.size === 0) return;

    function processAssignment(expr) {
      if (expr.type !== 'AssignmentExpression' || expr.operator !== '=') return;
      const left = expr.left;
      if (left.type !== 'MemberExpression' || left.computed) return;
      if (left.object.type !== 'Identifier' || left.property.type !== 'Identifier') return;
      const obj = emptyObjs.get(left.object.name);
      if (!obj) return;
      const key = left.property.name;
      if (expr.right.type === 'Literal') {
        obj[key] = { kind: 'literal', value: expr.right.value };
      } else if (expr.right.type === 'FunctionExpression' || expr.right.type === 'ArrowFunctionExpression') {
        const fp = analyzeFuncProxy(expr.right);
        if (fp) obj[key] = fp;
      }
    }

    for (const stmt of body) {
      if (stmt.type === 'ExpressionStatement') {
        if (stmt.expression.type === 'AssignmentExpression') {
          processAssignment(stmt.expression);
        } else if (stmt.expression.type === 'SequenceExpression') {
          for (const expr of stmt.expression.expressions) processAssignment(expr);
        }
      }
    }

    for (const [name, obj] of emptyObjs) {
      if (Object.keys(obj).length > 0) {
        const existing = proxyObjects.get(name);
        if (existing) Object.assign(existing, obj);
        else proxyObjects.set(name, obj);
      }
    }
  }

  applyToAllScopes(collectIncrementalProxies);

  // Collect aliases: const alias = origName where origName is a proxy
  walk.simple(ast, {
    VariableDeclaration(node) {
      for (const decl of node.declarations) {
        if (decl.id && decl.id.type === 'Identifier' && decl.init &&
            decl.init.type === 'Identifier' && proxyObjects.has(decl.init.name)) {
          proxyObjects.set(decl.id.name, proxyObjects.get(decl.init.name));
        }
      }
    }
  });

  if (proxyObjects.size > 0) console.log(`    Proxy objects collected: ${proxyObjects.size}`);

  // Inline function proxy calls: obj.func(a, b) → a OP b or func(a, b)
  let proxyInlined = 0;
  walk.simple(ast, {
    CallExpression(node) {
      if (!node.callee || node.callee.type !== 'MemberExpression') return;
      const mem = node.callee;
      if (mem.computed) return;
      if (mem.object.type !== 'Identifier') return;
      const propName = mem.property.type === 'Identifier' ? mem.property.name :
                       mem.property.type === 'Literal' ? String(mem.property.value) : null;
      if (!propName) return;

      const obj = proxyObjects.get(mem.object.name);
      if (!obj) return;
      const proxy = obj[propName];
      if (!proxy || proxy.kind === 'literal') return;

      const args = node.arguments;

      if (proxy.kind === 'binary' && args.length >= 2) {
        const newType = proxy.exprType || 'BinaryExpression';
        const left = args[proxy.leftIdx];
        const right = args[proxy.rightIdx];
        const keys = Object.keys(node);
        keys.forEach(k => { if (k !== 'start' && k !== 'end') delete node[k]; });
        node.type = newType;
        node.operator = proxy.operator;
        node.left = left;
        node.right = right;
        proxyInlined++;
      } else if (proxy.kind === 'call') {
        const callee = args[proxy.callerIdx];
        const newArgs = proxy.argIdxs.map(i => args[i]);
        const keys = Object.keys(node);
        keys.forEach(k => { if (k !== 'start' && k !== 'end') delete node[k]; });
        node.type = 'CallExpression';
        node.callee = callee;
        node.arguments = newArgs;
        node.optional = false;
        proxyInlined++;
      }
    }
  });

  // Tag MemberExpressions that are assignment targets (left side of =)
  const assignTargets = new WeakSet();
  walk.simple(ast, {
    AssignmentExpression(node) {
      if (node.left && node.left.type === 'MemberExpression') assignTargets.add(node.left);
    }
  });

  // Inline literal proxy lookups: obj.prop → 'value'
  walk.simple(ast, {
    MemberExpression(node) {
      if (assignTargets.has(node)) return;
      if (node.computed) return;
      if (node.object.type !== 'Identifier') return;
      const propName = node.property.type === 'Identifier' ? node.property.name :
                       node.property.type === 'Literal' ? String(node.property.value) : null;
      if (!propName) return;

      const obj = proxyObjects.get(node.object.name);
      if (!obj) return;
      const entry = obj[propName];
      if (!entry || entry.kind !== 'literal') return;

      replaceWithLiteral(node, entry.value);
      proxyInlined++;
    }
  });
  totalProxyInlined += proxyInlined;
  iterChanges += proxyInlined;
  if (proxyInlined) console.log(`    Proxy references inlined: ${proxyInlined}`);

  // --- Pass 2.4: Remove always-true/false conditions ---
  let deadBranchesRemoved = 0;

  // Use walk.simple to reach ALL body arrays (BlockStatement, Program, SwitchCase)
  // This avoids missing bodies nested inside non-block if-consequents (e.g. if(cond) try{...})
  function resolveDeadBranchesInBody(body) {
    if (!Array.isArray(body)) return;
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];
      if (stmt.type !== 'IfStatement') continue;
      const val = evalCondition(stmt.test);
      if (val === true) {
        const replacement = stmt.consequent.type === 'BlockStatement'
          ? stmt.consequent.body : [stmt.consequent];
        body.splice(i, 1, ...replacement);
        i--;
        deadBranchesRemoved++;
      } else if (val === false) {
        if (stmt.alternate) {
          const replacement = stmt.alternate.type === 'BlockStatement'
            ? stmt.alternate.body : [stmt.alternate];
          body.splice(i, 1, ...replacement);
          i--;
        } else {
          body.splice(i, 1);
          i--;
        }
        deadBranchesRemoved++;
      }
    }
  }

  walk.simple(ast, {
    Program(node) { resolveDeadBranchesInBody(node.body); },
    BlockStatement(node) { resolveDeadBranchesInBody(node.body); },
    SwitchCase(node) { resolveDeadBranchesInBody(node.consequent); }
  });

  // Also handle ConditionalExpression (ternary): cond ? a : b
  walk.simple(ast, {
    ConditionalExpression(node) {
      const val = evalCondition(node.test);
      if (val === true) {
        const keep = node.consequent;
        const keys = Object.keys(node);
        keys.forEach(k => { if (k !== 'start' && k !== 'end') delete node[k]; });
        Object.assign(node, keep);
        deadBranchesRemoved++;
      } else if (val === false) {
        const keep = node.alternate;
        const keys = Object.keys(node);
        keys.forEach(k => { if (k !== 'start' && k !== 'end') delete node[k]; });
        Object.assign(node, keep);
        deadBranchesRemoved++;
      }
    }
  });
  totalDeadBranches += deadBranchesRemoved;
  iterChanges += deadBranchesRemoved;
  if (deadBranchesRemoved) console.log(`    Dead branches removed: ${deadBranchesRemoved}`);

  // --- Pass 2.4b: Remove unreachable code ---
  // Statements after return/throw/break/continue in a body array are unreachable
  let unreachableRemoved = 0;
  const TERMINATING = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement']);

  function removeUnreachable(body) {
    if (!Array.isArray(body)) return;
    for (let i = 0; i < body.length; i++) {
      if (TERMINATING.has(body[i].type)) {
        // Remove everything after this statement in the same body
        const removed = body.splice(i + 1);
        unreachableRemoved += removed.length;
        break;
      }
    }
  }

  // Apply to all body arrays in all scopes
  walk.simple(ast, {
    BlockStatement(node) { removeUnreachable(node.body); },
    Program(node) { removeUnreachable(node.body); },
    SwitchCase(node) { removeUnreachable(node.consequent); }
  });
  totalUnreachable += unreachableRemoved;
  iterChanges += unreachableRemoved;
  if (unreachableRemoved) console.log(`    Unreachable code removed: ${unreachableRemoved} statements`);

  // --- Pass 2.5: Split comma expressions into separate statements ---
  let commasSplit = 0;

  function splitCommaExpressions(body) {
    if (!Array.isArray(body)) return;

    for (let i = 0; i < body.length; i++) {
      const stmt = body[i];

      // ExpressionStatement with SequenceExpression
      if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'SequenceExpression') {
        const exprs = stmt.expression.expressions;
        const newStmts = exprs.map(e => ({ type: 'ExpressionStatement', expression: e }));
        body.splice(i, 1, ...newStmts);
        commasSplit += exprs.length - 1;
        i += newStmts.length - 1;
        continue;
      }

      // ReturnStatement with SequenceExpression: return (a, b, c) → a; b; return c;
      if (stmt.type === 'ReturnStatement' && stmt.argument && stmt.argument.type === 'SequenceExpression') {
        const exprs = stmt.argument.expressions;
        if (exprs.length > 1) {
          const newStmts = [];
          for (let j = 0; j < exprs.length - 1; j++) {
            newStmts.push({ type: 'ExpressionStatement', expression: exprs[j] });
          }
          newStmts.push({ type: 'ReturnStatement', argument: exprs[exprs.length - 1] });
          body.splice(i, 1, ...newStmts);
          commasSplit += exprs.length - 1;
          i += newStmts.length - 1;
          continue;
        }
      }

      // Recurse
      if (stmt.body) {
        if (Array.isArray(stmt.body)) splitCommaExpressions(stmt.body);
        else if (stmt.body.body) splitCommaExpressions(stmt.body.body);
      }
      if (stmt.type === 'IfStatement') {
        if (stmt.consequent && stmt.consequent.type === 'BlockStatement') splitCommaExpressions(stmt.consequent.body);
        if (stmt.alternate && stmt.alternate.type === 'BlockStatement') splitCommaExpressions(stmt.alternate.body);
      }
      if (stmt.type === 'TryStatement') {
        if (stmt.block && stmt.block.body) splitCommaExpressions(stmt.block.body);
        if (stmt.handler && stmt.handler.body && stmt.handler.body.body) splitCommaExpressions(stmt.handler.body.body);
        if (stmt.finalizer && stmt.finalizer.body) splitCommaExpressions(stmt.finalizer.body);
      }
      if (stmt.type === 'SwitchStatement') {
        for (const c of stmt.cases || []) {
          if (c.consequent) splitCommaExpressions(c.consequent);
        }
      }
    }
  }

  applyToAllScopes(splitCommaExpressions);
  totalCommasSplit += commasSplit;
  iterChanges += commasSplit;
  if (commasSplit) console.log(`    Comma expressions split: ${commasSplit}`);

  // --- Pass 2.6: Remove dead numeric const objects ---
  let deadObjectsRemoved = 0;

  function removeDeadNumericObjects(body) {
    if (!Array.isArray(body)) return;

    for (let i = body.length - 1; i >= 0; i--) {
      const stmt = body[i];

      if (stmt.type === 'VariableDeclaration') {
        stmt.declarations = stmt.declarations.filter(decl => {
          if (!decl.id || decl.id.type !== 'Identifier' || !decl.init) return true;
          if (decl.init.type !== 'ObjectExpression') return true;
          const props = decl.init.properties;
          if (props.length === 0) return true;

          const allDeadNumeric = props.every(p => {
            if (p.type !== 'Property') return false;
            if (p.key.type !== 'Identifier' || !p.key.name.startsWith('_0x')) return false;
            if (p.value.type === 'Literal' && typeof p.value.value === 'number') return true;
            if (p.value.type === 'UnaryExpression' && p.value.operator === '-' &&
                p.value.argument.type === 'Literal' && typeof p.value.argument.value === 'number') return true;
            return false;
          });

          if (allDeadNumeric) {
            deadObjectsRemoved++;
            return false;
          }
          return true;
        });

        if (stmt.declarations.length === 0) {
          body.splice(i, 1);
          continue;
        }
      }

      // Recurse
      if (stmt.body) {
        if (Array.isArray(stmt.body)) removeDeadNumericObjects(stmt.body);
        else if (stmt.body.body) removeDeadNumericObjects(stmt.body.body);
      }
      if (stmt.type === 'IfStatement') {
        if (stmt.consequent && stmt.consequent.type === 'BlockStatement') removeDeadNumericObjects(stmt.consequent.body);
        if (stmt.alternate && stmt.alternate.type === 'BlockStatement') removeDeadNumericObjects(stmt.alternate.body);
      }
      if (stmt.type === 'TryStatement') {
        if (stmt.block && stmt.block.body) removeDeadNumericObjects(stmt.block.body);
        if (stmt.handler && stmt.handler.body && stmt.handler.body.body) removeDeadNumericObjects(stmt.handler.body.body);
        if (stmt.finalizer && stmt.finalizer.body) removeDeadNumericObjects(stmt.finalizer.body);
      }
      if (stmt.type === 'SwitchStatement') {
        for (const c of stmt.cases || []) {
          if (c.consequent) removeDeadNumericObjects(c.consequent);
        }
      }
    }
  }

  applyToAllScopes(removeDeadNumericObjects);
  totalDeadObjects += deadObjectsRemoved;
  iterChanges += deadObjectsRemoved;
  if (deadObjectsRemoved) console.log(`    Dead numeric objects removed: ${deadObjectsRemoved}`);

  // --- Pass 2.7: Remove proxy object declarations and aliases that are now unused ---
  let proxyDeclsRemoved = 0;
  const proxyNames = new Set(proxyObjects.keys());

  function removeDeadProxies(deadSet) {
    walk.simple(ast, {
      VariableDeclaration(node) {
        node.declarations = node.declarations.filter(decl => {
          if (!decl.id || decl.id.type !== 'Identifier') return true;
          if (!deadSet.has(decl.id.name)) return true;
          proxyDeclsRemoved++;
          return false;
        });
      }
    });

    const deadNodes = new WeakSet();
    walk.simple(ast, {
      VariableDeclaration(node) {
        if (node.declarations.length === 0) deadNodes.add(node);
      },
      ExpressionStatement(node) {
        if (node.expression.type === 'AssignmentExpression') {
          const left = node.expression.left;
          if (left.type === 'MemberExpression' && left.object.type === 'Identifier' &&
              deadSet.has(left.object.name)) {
            deadNodes.add(node);
            proxyDeclsRemoved++;
          }
        }
      }
    });

    function cleanBody(body) {
      if (!Array.isArray(body)) return;
      for (let i = body.length - 1; i >= 0; i--) {
        if (deadNodes.has(body[i])) body.splice(i, 1);
      }
    }

    walk.simple(ast, {
      Program(node) { cleanBody(node.body); },
      BlockStatement(node) { cleanBody(node.body); },
      SwitchCase(node) { cleanBody(node.consequent); }
    });
  }

  let iterDeadProxies = 0;
  for (let sub = 0; sub < 10; sub++) {
    const identRefs = new Map();
    walk.full(ast, (node) => {
      if (node.type === 'Identifier') identRefs.set(node.name, (identRefs.get(node.name) || 0) + 1);
    });

    const setupRefs = new Map();
    for (const name of proxyNames) setupRefs.set(name, 0);

    walk.simple(ast, {
      VariableDeclarator(node) {
        if (node.id && node.id.type === 'Identifier' && proxyNames.has(node.id.name))
          setupRefs.set(node.id.name, (setupRefs.get(node.id.name) || 0) + 1);
      }
    });
    walk.simple(ast, {
      AssignmentExpression(node) {
        if (node.left.type === 'MemberExpression' && node.left.object.type === 'Identifier' &&
            proxyNames.has(node.left.object.name))
          setupRefs.set(node.left.object.name, (setupRefs.get(node.left.object.name) || 0) + 1);
      }
    });

    const deadProxies = new Set();
    for (const name of proxyNames) {
      const total = identRefs.get(name) || 0;
      const setup = setupRefs.get(name) || 0;
      if (total <= setup) deadProxies.add(name);
    }

    if (deadProxies.size === 0) break;
    iterDeadProxies += deadProxies.size;

    removeDeadProxies(deadProxies);
    for (const name of deadProxies) proxyNames.delete(name);
  }

  totalProxyDeclsRemoved += proxyDeclsRemoved;
  totalDeadProxies += iterDeadProxies;
  iterChanges += proxyDeclsRemoved;
  if (proxyDeclsRemoved) console.log(`    Unused proxy declarations removed: ${proxyDeclsRemoved} (${iterDeadProxies} dead proxies)`);

  console.log(`    Iteration ${iteration} total changes: ${iterChanges}`);
  if (iterChanges === 0) {
    console.log(`  Converged after ${iteration} iteration(s).`);
    break;
  }
}

console.log('\n  === Phase 2 Totals ===');
console.log(`  Arithmetic resolved: ${totalArithmetic}`);
console.log(`  Booleans resolved: ${totalBooleans}`);
console.log(`  Proxy references inlined: ${totalProxyInlined}`);
console.log(`  Dead branches removed: ${totalDeadBranches}`);
console.log(`  Unreachable code removed: ${totalUnreachable}`);
console.log(`  Comma expressions split: ${totalCommasSplit}`);
console.log(`  Dead numeric objects removed: ${totalDeadObjects}`);
console.log(`  Unused proxy declarations removed: ${totalProxyDeclsRemoved} (${totalDeadProxies} dead proxies)`);

console.log('\n=== Phase 2 Complete ===');

// ======== Phase 3: Variable Renaming ========
console.log('\n=== Phase 3: Variable Renaming ===');

// Step 1: Collect all existing non-_0x identifiers to avoid collisions
const existingNames = new Set();
walk.full(ast, node => {
  if (node.type === 'Identifier' && !node.name.startsWith('_0x'))
    existingNames.add(node.name);
});

const renameMap = new Map();
const usedNewNames = new Set();

function makeUnique(base) {
  // Sanitize: only allow valid JS identifier chars
  base = base.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  if (!base) base = '_v';
  let name = base;
  let i = 2;
  while (existingNames.has(name) || usedNewNames.has(name)) {
    name = base + i++;
  }
  usedNewNames.add(name);
  return name;
}

// Sequential name generator: _a, _b, ..., _z, _A, ..., _Z, _aa, _ab, ...
let seqIdx = 0;
function nextSeqName() {
  while (true) {
    let n = seqIdx++;
    let name = '_';
    do {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
      name += chars[n % chars.length];
      n = Math.floor(n / chars.length) - 1;
    } while (n >= 0);
    if (!existingNames.has(name) && !usedNewNames.has(name)) {
      usedNewNames.add(name);
      return name;
    }
  }
}

// Helper: get string from a Literal or simple template
function getLiteralString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

// Helper: get method name from a CallExpression's callee
function getMethodName(callNode) {
  if (callNode.callee.type === 'MemberExpression' && !callNode.callee.computed) {
    const prop = callNode.callee.property;
    return prop.type === 'Identifier' ? prop.name : getLiteralString(prop);
  }
  if (callNode.callee.type === 'Identifier') return callNode.callee.name;
  return null;
}

// Infer a meaningful name from a VariableDeclarator's init expression
function inferFromInit(init) {
  if (!init) return null;

  // Unwrap await
  if (init.type === 'AwaitExpression') {
    const inner = inferFromInit(init.argument);
    if (inner) return inner;
    // If inner is a fetch call, name the await result 'response'
    if (init.argument.type === 'CallExpression') {
      const m = getMethodName(init.argument);
      if (m === 'fetch') return 'response';
    }
    return null;
  }

  if (init.type === 'CallExpression') {
    const method = getMethodName(init);

    // document.getElementById('status') → statusEl
    if (method === 'getElementById') {
      const arg = getLiteralString(init.arguments[0]);
      if (arg) {
        // camelCase from kebab-case: 'btn-allow' → 'btnAllow'
        const camel = arg.replace(/[-_](.)/g, (_, c) => c.toUpperCase());
        return camel + 'El';
      }
    }

    // document.createElement('div') → divEl
    if (method === 'createElement') {
      const arg = getLiteralString(init.arguments[0]);
      if (arg) return arg + 'El';
    }

    // document.querySelector('.class') / ('#id')
    if (method === 'querySelector' || method === 'querySelectorAll') {
      const arg = getLiteralString(init.arguments[0]);
      if (arg) {
        const match = arg.match(/[#.]([a-zA-Z][\w-]*)/);
        if (match) {
          const camel = match[1].replace(/[-_](.)/g, (_, c) => c.toUpperCase());
          return camel + (method === 'querySelectorAll' ? 'Els' : 'El');
        }
      }
    }

    // .json() → data
    if (method === 'json') return 'data';
    // .text() → textData
    if (method === 'text') return 'textData';
    // .keys() → keys
    if (method === 'keys') return 'keys';
    // .values() → values
    if (method === 'values') return 'values';
    // .entries() → entries
    if (method === 'entries') return 'entries';
    // .match() → match
    if (method === 'match') return 'match';
    // .split() → parts
    if (method === 'split') return 'parts';

    // fetch(...) → response
    if (method === 'fetch') return 'response';

    // Promise.all → results
    if (method === 'all') return 'results';
  }

  // new ClassName() → className
  if (init.type === 'NewExpression' && init.callee.type === 'Identifier') {
    const name = init.callee.name;
    // Common: new FileReader → fileReader, new TextEncoder → textEncoder
    return name[0].toLowerCase() + name.slice(1);
  }

  // Object literal {} → opts (common pattern for building options)
  if (init.type === 'ObjectExpression') return 'opts';

  // Array literal [] → arr
  if (init.type === 'ArrayExpression') return 'arr';

  return null;
}

// Step 2: Collect _0x names from VariableDeclarators with context inference
let inferredCount = 0;
walk.simple(ast, {
  VariableDeclarator(node) {
    if (!node.id || node.id.type !== 'Identifier') return;
    if (!node.id.name.startsWith('_0x')) return;
    if (renameMap.has(node.id.name)) return;

    const inferred = inferFromInit(node.init);
    if (inferred) {
      renameMap.set(node.id.name, makeUnique(inferred));
      inferredCount++;
    }
  }
});

// Step 3: Rename catch clause params → err
walk.simple(ast, {
  CatchClause(node) {
    if (node.param && node.param.type === 'Identifier' && node.param.name.startsWith('_0x')) {
      if (!renameMap.has(node.param.name)) {
        renameMap.set(node.param.name, makeUnique('err'));
        inferredCount++;
      }
    }
  }
});

// Step 4: Rename callback params with context hints
walk.simple(ast, {
  CallExpression(node) {
    const method = getMethodName(node);
    if (!method) return;

    // .addEventListener('event', (e) => ...) → e
    if (method === 'addEventListener') {
      const cb = node.arguments[1];
      if (cb && (cb.type === 'FunctionExpression' || cb.type === 'ArrowFunctionExpression')) {
        for (const p of cb.params) {
          if (p.type === 'Identifier' && p.name.startsWith('_0x') && !renameMap.has(p.name)) {
            renameMap.set(p.name, makeUnique('event'));
            inferredCount++;
            break; // only first param
          }
        }
      }
    }

    // .map(item => ...), .filter(item => ...), .forEach(item => ...), .find(item => ...)
    if (['map', 'filter', 'forEach', 'find', 'findIndex', 'some', 'every', 'reduce'].includes(method)) {
      const cb = node.arguments[0];
      if (cb && (cb.type === 'FunctionExpression' || cb.type === 'ArrowFunctionExpression')) {
        const paramNames = ['item', 'index', 'array'];
        if (method === 'reduce') paramNames.unshift('acc');
        cb.params.forEach((p, idx) => {
          if (p.type === 'Identifier' && p.name.startsWith('_0x') && !renameMap.has(p.name)) {
            renameMap.set(p.name, makeUnique(paramNames[idx] || 'param'));
            inferredCount++;
          }
        });
      }
    }

    // .then(result => ...), .catch(err => ...)
    if (method === 'then') {
      const cb = node.arguments[0];
      if (cb && (cb.type === 'FunctionExpression' || cb.type === 'ArrowFunctionExpression')) {
        for (const p of cb.params) {
          if (p.type === 'Identifier' && p.name.startsWith('_0x') && !renameMap.has(p.name)) {
            renameMap.set(p.name, makeUnique('result'));
            inferredCount++;
            break;
          }
        }
      }
    }
    if (method === 'catch') {
      const cb = node.arguments[0];
      if (cb && (cb.type === 'FunctionExpression' || cb.type === 'ArrowFunctionExpression')) {
        for (const p of cb.params) {
          if (p.type === 'Identifier' && p.name.startsWith('_0x') && !renameMap.has(p.name)) {
            renameMap.set(p.name, makeUnique('err'));
            inferredCount++;
            break;
          }
        }
      }
    }
  },

  // new Promise((resolve, reject) => ...)
  NewExpression(node) {
    if (node.callee.type === 'Identifier' && node.callee.name === 'Promise') {
      const cb = node.arguments[0];
      if (cb && (cb.type === 'FunctionExpression' || cb.type === 'ArrowFunctionExpression')) {
        const pNames = ['resolve', 'reject'];
        cb.params.forEach((p, idx) => {
          if (p.type === 'Identifier' && p.name.startsWith('_0x') && !renameMap.has(p.name)) {
            renameMap.set(p.name, makeUnique(pNames[idx] || 'param'));
            inferredCount++;
          }
        });
      }
    }
  }
});

// Step 5: Assign sequential names to all remaining _0x identifiers
const allOxNames = new Set();
walk.full(ast, node => {
  if (node.type === 'Identifier' && node.name.startsWith('_0x'))
    allOxNames.add(node.name);
});

let seqCount = 0;
for (const name of allOxNames) {
  if (!renameMap.has(name)) {
    renameMap.set(name, nextSeqName());
    seqCount++;
  }
}

// Step 6: Apply all renames
let renameCount = 0;
walk.full(ast, node => {
  if (node.type === 'Identifier' && renameMap.has(node.name)) {
    node.name = renameMap.get(node.name);
    renameCount++;
  }
});

console.log(`  Context-inferred names: ${inferredCount}`);
console.log(`  Sequential names: ${seqCount}`);
console.log(`  Total identifiers renamed: ${renameCount}`);
console.log('\n=== Phase 3 Complete ===');

// Generate output
const output = escodegen.generate(ast, {
  format: {
    indent: { style: '  ' },
    quotes: 'single',
    semicolons: true
  }
});

const outputFile = inputFile.replace('.js', '.deobf.js');
writeFileSync(outputFile, output);
console.log(`Written to ${outputFile} (${output.length} bytes)`);
