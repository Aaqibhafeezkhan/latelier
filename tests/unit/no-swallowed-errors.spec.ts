import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// The renderer has a channel to the main log (`logToMain` / `logFailure`), so a
// rejection or a failed await must not vanish. ESLint's no-empty accepts a
// comment-only block and has no rule for `.catch(() => {})`, so this walks the
// syntax tree itself.

// A catch around a parser that falls back to a lenient path is control flow,
// not a lost failure, and one call is dropped on purpose. Each entry is keyed
// by file and the exact source text (whitespace collapsed) of the flagged
// node, so any other swallow in the same file is still flagged.
const ALLOWED: ReadonlyArray<{ file: string; text: string; why: string }> = [
  {
    file: 'src/features/fieldSuggestions/useSuggestions.ts',
    text: 'p.catch(() => undefined)',
    why: 'the sync pass runs async sources only to find out they are async; the effect runs them again and owns the outcome',
  },
  {
    file: 'src/pages/Workspace/Aggregation/pipeline.ts',
    text: 'catch { // fall through }',
    why: 'a stage body that does not parse falls back to a first-line summary',
  },
  {
    file: 'src/pages/Workspace/projection.ts',
    text: 'catch { // Fall through to lenient parsing. }',
    why: 'text that is not strict JSON is parsed leniently right after',
  },
  {
    file: 'src/utils/shellSyntax.ts',
    text: 'catch { // Not Canonical EJSON yet — try to repair it. }',
    why: 'the strict parse is the first attempt; the repair path follows',
  },
];

// A value that says nothing about the failure: undefined, a literal, or an
// empty array or object.
function isConstant(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return isConstant(e.expression);
  return (
    ts.isVoidExpression(e) ||
    (ts.isIdentifier(e) && e.text === 'undefined') ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isNumericLiteral(e) ||
    ts.isStringLiteralLike(e) ||
    (ts.isArrayLiteralExpression(e) && e.elements.length === 0) ||
    (ts.isObjectLiteralExpression(e) && e.properties.length === 0)
  );
}

function isConsoleCall(e: ts.Expression): boolean {
  return (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    e.expression.expression.text === 'console'
  );
}

// A handler that neither uses the error nor reports it anywhere the main log
// can see: empty, a constant, or a lone console call.
function isSwallowingHandler(arg: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(arg)) {
    return ts.isIdentifier(arg.expression) && arg.expression.text === 'console';
  }
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return false;
  const body = arg.body;
  if (!ts.isBlock(body)) return isConstant(body) || isConsoleCall(body);
  if (body.statements.length === 0) return true;
  if (body.statements.length > 1) return false;
  const only = body.statements[0]!;
  if (ts.isReturnStatement(only)) return only.expression === undefined || isConstant(only.expression);
  return ts.isExpressionStatement(only) && isConsoleCall(only.expression);
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

function findSwallowedErrors(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const at = (n: ts.Node, what: string) => {
    const file = fileName.split(path.sep).join('/');
    const text = squash(n.getText(sf));
    if (ALLOWED.some((a) => a.file === file && a.text === text)) return;
    hits.push(`${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${what}: ${text}`);
  };
  const visit = (n: ts.Node) => {
    if (ts.isCatchClause(n) && n.block.statements.length === 0) at(n, 'empty catch');
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.name.text;
      // `.then(ok, onRejected)` swallows through its second argument.
      const handler = name === 'catch' ? n.arguments[0] : name === 'then' ? n.arguments[1] : undefined;
      if (handler && isSwallowingHandler(handler)) at(n, `.${name} handler that drops the error`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe('swallowed errors in src/', () => {
  it('finds no empty catch and no .catch or .then rejection handler that drops the error', () => {
    const hits = sourceFiles('src')
      .flatMap((f) => findSwallowedErrors(f, readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('flags each swallowing shape', () => {
    const src = [
      'async function f() {',
      '  try { await g(); } catch { /* ignore */ }',
      '  g().catch(() => {});',
      '  g().catch(() => { /* ok */ });',
      '  g().catch(() => undefined);',
      '  g().catch(() => void 0);',
      '  g().catch(console.warn);',
      '  g().catch((e) => console.warn("x", e));',
      '  g().catch(() => null);',
      '  g().catch(() => { return false; });',
      '  g().catch(() => []);',
      '  g().then(ok, () => {});',
      '  g().then(ok, () => 0);',
      '  try { for await (const x of it()) use(x); } catch { /* ignore */ }',
      '  try { JSON.parse(s); } catch { /* lenient path */ }',
      '}',
    ].join('\n');
    expect(findSwallowedErrors('x.ts', src).map((h) => h.split(' ')[0])).toEqual(
      Array.from({ length: 14 }, (_, i) => `x.ts:${i + 2}`),
    );
  });

  it('accepts a handler that reports the error or acts on it', () => {
    const src = [
      'async function f() {',
      '  try { await g(); } catch (e) { log(e); }',
      '  g().catch((e) => log(e));',
      '  g().catch((e) => { log(e); return null; });',
      '  g().then(ok, (e) => log(e));',
      '  g().then(() => {});',
      '}',
    ].join('\n');
    expect(findSwallowedErrors('x.ts', src)).toEqual([]);
  });

  it('allows a listed call only in its own file, and only that exact call', () => {
    const file = 'src/features/fieldSuggestions/useSuggestions.ts';
    expect(findSwallowedErrors(file, 'p.catch(() => undefined);')).toEqual([]);
    expect(findSwallowedErrors(file, 'q.catch(() => undefined);\np.catch(() => null);')).toHaveLength(2);
    expect(findSwallowedErrors('src/other.ts', 'p.catch(() => undefined);')).toHaveLength(1);
  });
});
