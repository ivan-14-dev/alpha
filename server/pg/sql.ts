/**
 * Minimal SQLite SQL tokenizer and DDL parsers used by the PostgreSQL converter.
 * They only need to understand statements stored in `sqlite_schema.sql`, which SQLite already validated.
 */

export type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'blob' | 'op' | 'param';

export interface Token {
  kind: TokenKind;
  /** Keyword/identifier as written, unescaped quoted identifier or string, number text, blob hex digits or operator. */
  value: string;
  start: number;
  end: number;
}

const THREE_CHAR_OPS = ['->>'];
const TWO_CHAR_OPS = ['||', '<=', '>=', '==', '!=', '<>', '<<', '>>', '->'];
const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const NUMBER = /^(0[xX][0-9a-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/;

export class SqlParseError extends Error {}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = sql.length;
  while (i < length) {
    const char = sql[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '-' && sql[i + 1] === '-') {
      while (i < length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? length : close + 2;
      continue;
    }
    const start = i;
    if ((char === 'x' || char === 'X') && sql[i + 1] === "'") {
      const close = sql.indexOf("'", i + 2);
      if (close === -1) throw new SqlParseError('Littéral BLOB non terminé.');
      tokens.push({ kind: 'blob', value: sql.slice(i + 2, close).toLowerCase(), start, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (WORD_START.test(char)) {
      i += 1;
      while (i < length && WORD_PART.test(sql[i])) i += 1;
      tokens.push({ kind: 'word', value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= length) throw new SqlParseError('Chaîne ou identifiant non terminé.');
        if (sql[i] === char) {
          if (sql[i + 1] === char) { value += char; i += 2; continue; }
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      tokens.push({ kind: char === "'" ? 'string' : 'quoted', value, start, end: i });
      continue;
    }
    if (char === '[') {
      const close = sql.indexOf(']', i + 1);
      if (close === -1) throw new SqlParseError('Identifiant entre crochets non terminé.');
      tokens.push({ kind: 'quoted', value: sql.slice(i + 1, close), start, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (/\d/.test(char) || (char === '.' && /\d/.test(sql[i + 1] ?? ''))) {
      const number = NUMBER.exec(sql.slice(i, i + 80))!;
      i += number[0].length;
      tokens.push({ kind: 'number', value: number[0].replace(/_/g, ''), start, end: i });
      continue;
    }
    if (char === '?' || ((char === ':' || char === '@' || char === '$') && WORD_START.test(sql[i + 1] ?? ''))) {
      i += 1;
      while (i < length && WORD_PART.test(sql[i])) i += 1;
      tokens.push({ kind: 'param', value: sql.slice(start, i), start, end: i });
      continue;
    }
    const three = sql.slice(i, i + 3);
    const two = sql.slice(i, i + 2);
    const op = THREE_CHAR_OPS.includes(three) ? three : TWO_CHAR_OPS.includes(two) ? two : char;
    i += op.length;
    tokens.push({ kind: 'op', value: op, start, end: i });
  }
  return tokens;
}

export function isWord(token: Token | undefined, ...words: string[]): boolean {
  return !!token && token.kind === 'word' && words.includes(token.value.toUpperCase());
}

export function isOp(token: Token | undefined, ...ops: string[]): boolean {
  return !!token && token.kind === 'op' && ops.includes(token.value);
}

/** Name carried by an identifier-like token (unquoted word, quoted identifier or string used as a name). */
export function nameOf(token: Token | undefined): string {
  if (!token || !['word', 'quoted', 'string'].includes(token.kind)) throw new SqlParseError('Identifiant attendu.');
  return token.value;
}

/** Index of the parenthesis closing the one at `open`. */
export function matchParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isOp(tokens[i], '(')) depth += 1;
    else if (isOp(tokens[i], ')')) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new SqlParseError('Parenthèse non fermée.');
}

/** Splits on a separator operator found outside parentheses. */
export function splitTopLevel(tokens: Token[], separator = ','): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (isOp(token, '(')) depth += 1;
    if (isOp(token, ')')) depth -= 1;
    if (depth === 0 && isOp(token, separator)) {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length || parts.length) parts.push(current);
  return parts;
}

export function sourceText(sql: string, tokens: Token[]): string {
  if (!tokens.length) return '';
  return sql.slice(tokens[0].start, tokens[tokens.length - 1].end);
}

function nameList(tokens: Token[]): string[] {
  return splitTopLevel(tokens).filter((part) => part.length).map((part) => nameOf(part[0]));
}

export interface ParsedReference {
  columns: string[];
  table: string;
  refColumns: string[];
  deferrable: boolean;
  initiallyDeferred: boolean;
}

export interface ParsedCheck {
  name?: string;
  column?: string;
  tokens: Token[];
  text: string;
}

export interface ParsedColumn {
  name: string;
  typeText: string;
  collate?: string;
  generated?: { tokens: Token[]; stored: boolean; text: string };
  autoincrement: boolean;
}

export interface ParsedTable {
  name: string;
  columns: ParsedColumn[];
  checks: ParsedCheck[];
  references: ParsedReference[];
  /** Non-default `ON CONFLICT` clauses, which PostgreSQL cannot express in DDL. */
  conflictClauses: string[];
  withoutRowid: boolean;
  strict: boolean;
  asSelect: boolean;
}

const COLUMN_CONSTRAINT_START = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS']);

/** Parses `REFERENCES table [(cols)] [ON DELETE ...] [DEFERRABLE ...]` starting at the REFERENCES keyword. */
function parseReference(tokens: Token[], start: number, columns: string[]): { reference: ParsedReference; next: number } {
  let i = start + 1;
  const table = nameOf(tokens[i]);
  i += 1;
  let refColumns: string[] = [];
  if (isOp(tokens[i], '(')) {
    const close = matchParen(tokens, i);
    refColumns = nameList(tokens.slice(i + 1, close));
    i = close + 1;
  }
  let deferrable = false;
  let initiallyDeferred = false;
  while (i < tokens.length) {
    if (isWord(tokens[i], 'ON')) {
      i += 2;
      i += isWord(tokens[i], 'SET', 'NO') ? 2 : 1;
    } else if (isWord(tokens[i], 'MATCH')) {
      i += 2;
    } else if (isWord(tokens[i], 'NOT') && isWord(tokens[i + 1], 'DEFERRABLE')) {
      i += 2;
    } else if (isWord(tokens[i], 'DEFERRABLE')) {
      deferrable = true;
      i += 1;
    } else if (isWord(tokens[i], 'INITIALLY')) {
      initiallyDeferred = deferrable && isWord(tokens[i + 1], 'DEFERRED');
      i += 2;
    } else break;
  }
  return { reference: { columns, table, refColumns, deferrable, initiallyDeferred }, next: i };
}

function parseConflict(tokens: Token[], i: number, clauses: string[], subject: string): number {
  if (isWord(tokens[i], 'ON') && isWord(tokens[i + 1], 'CONFLICT')) {
    const action = tokens[i + 2]?.value.toUpperCase() ?? '';
    if (action !== 'ABORT') clauses.push(`${subject} ON CONFLICT ${action}`);
    return i + 3;
  }
  return i;
}

export function parseCreateTable(sql: string): ParsedTable {
  const tokens = tokenize(sql);
  let i = tokens.findIndex((token) => isWord(token, 'TABLE'));
  if (i === -1) throw new SqlParseError('Instruction CREATE TABLE attendue.');
  i += 1;
  if (isWord(tokens[i], 'IF')) i += 3;
  let name = nameOf(tokens[i]);
  i += 1;
  if (isOp(tokens[i], '.')) { name = nameOf(tokens[i + 1]); i += 2; }
  const table: ParsedTable = { name, columns: [], checks: [], references: [], conflictClauses: [], withoutRowid: false, strict: false, asSelect: false };
  if (isWord(tokens[i], 'AS')) { table.asSelect = true; return table; }
  const close = matchParen(tokens, i);
  for (let j = close + 1; j < tokens.length; j += 1) {
    if (isWord(tokens[j], 'ROWID')) table.withoutRowid = true;
    if (isWord(tokens[j], 'STRICT')) table.strict = true;
  }
  for (const definition of splitTopLevel(tokens.slice(i + 1, close))) {
    if (!definition.length) continue;
    let k = 0;
    let constraintName: string | undefined;
    if (isWord(definition[0], 'CONSTRAINT')) { constraintName = nameOf(definition[1]); k = 2; }
    const head = definition[k];
    if (isWord(head, 'PRIMARY', 'UNIQUE') && (isWord(definition[k + 1], 'KEY') || isOp(definition[k + 1], '('))) {
      const open = definition.findIndex((token, index) => index > k && isOp(token, '('));
      const end = matchParen(definition, open);
      parseConflict(definition, end + 1, table.conflictClauses, `${head.value.toUpperCase()} (${nameList(definition.slice(open + 1, end)).join(', ')})`);
      continue;
    }
    if (isWord(head, 'CHECK') && isOp(definition[k + 1], '(')) {
      const end = matchParen(definition, k + 1);
      const inner = definition.slice(k + 2, end);
      table.checks.push({ name: constraintName, tokens: inner, text: sourceText(sql, inner) });
      continue;
    }
    if (isWord(head, 'FOREIGN') && isWord(definition[k + 1], 'KEY')) {
      const open = k + 2;
      const end = matchParen(definition, open);
      table.references.push(parseReference(definition, end + 1, nameList(definition.slice(open + 1, end))).reference);
      continue;
    }
    table.columns.push(parseColumn(sql, definition, table));
  }
  return table;
}

function parseColumn(sql: string, definition: Token[], table: ParsedTable): ParsedColumn {
  const column: ParsedColumn = { name: nameOf(definition[0]), typeText: '', autoincrement: false };
  let i = 1;
  const typeTokens: Token[] = [];
  while (i < definition.length && !(definition[i].kind === 'word' && COLUMN_CONSTRAINT_START.has(definition[i].value.toUpperCase()))) {
    const end = isOp(definition[i], '(') ? matchParen(definition, i) : i;
    typeTokens.push(...definition.slice(i, end + 1));
    i = end + 1;
  }
  column.typeText = sourceText(sql, typeTokens);
  let constraintName: string | undefined;
  while (i < definition.length) {
    const token = definition[i];
    if (isWord(token, 'CONSTRAINT')) { constraintName = nameOf(definition[i + 1]); i += 2; continue; }
    if (isWord(token, 'PRIMARY')) {
      i += 2;
      if (isWord(definition[i], 'ASC', 'DESC')) i += 1;
      i = parseConflict(definition, i, table.conflictClauses, `PRIMARY KEY (${column.name})`);
      if (isWord(definition[i], 'AUTOINCREMENT')) { column.autoincrement = true; i += 1; }
    } else if (isWord(token, 'NOT') && isWord(definition[i + 1], 'NULL')) {
      i = parseConflict(definition, i + 2, table.conflictClauses, `NOT NULL (${column.name})`);
    } else if (isWord(token, 'UNIQUE')) {
      i = parseConflict(definition, i + 1, table.conflictClauses, `UNIQUE (${column.name})`);
    } else if (isWord(token, 'CHECK')) {
      const close = matchParen(definition, i + 1);
      const inner = definition.slice(i + 2, close);
      table.checks.push({ name: constraintName, column: column.name, tokens: inner, text: sourceText(sql, inner) });
      i = close + 1;
    } else if (isWord(token, 'DEFAULT')) {
      i += 1;
      if (isOp(definition[i], '(')) i = matchParen(definition, i) + 1;
      else i += isOp(definition[i], '+', '-') ? 2 : 1;
    } else if (isWord(token, 'COLLATE')) {
      column.collate = nameOf(definition[i + 1]).toUpperCase();
      i += 2;
    } else if (isWord(token, 'REFERENCES')) {
      const parsed = parseReference(definition, i, [column.name]);
      table.references.push(parsed.reference);
      i = parsed.next;
    } else if (isWord(token, 'GENERATED', 'AS')) {
      i += isWord(token, 'GENERATED') ? 3 : 1;
      const close = matchParen(definition, i);
      const inner = definition.slice(i + 1, close);
      i = close + 1;
      let stored = false;
      if (isWord(definition[i], 'STORED', 'VIRTUAL')) { stored = isWord(definition[i], 'STORED'); i += 1; }
      column.generated = { tokens: inner, stored, text: sourceText(sql, inner) };
    } else {
      i += 1;
    }
    constraintName = undefined;
  }
  return column;
}

export interface ParsedIndexColumn {
  tokens: Token[];
  text: string;
  collate?: string;
  descending: boolean;
}

export interface ParsedIndex {
  name: string;
  table: string;
  unique: boolean;
  columns: ParsedIndexColumn[];
  where?: Token[];
  whereText?: string;
}

export function parseCreateIndex(sql: string): ParsedIndex {
  const tokens = tokenize(sql).filter((token, index, list) => !(index === list.length - 1 && isOp(token, ';')));
  const unique = isWord(tokens[1], 'UNIQUE');
  let i = tokens.findIndex((token) => isWord(token, 'INDEX')) + 1;
  if (isWord(tokens[i], 'IF')) i += 3;
  let name = nameOf(tokens[i]);
  i += 1;
  if (isOp(tokens[i], '.')) { name = nameOf(tokens[i + 1]); i += 2; }
  if (!isWord(tokens[i], 'ON')) throw new SqlParseError('ON attendu dans CREATE INDEX.');
  const table = nameOf(tokens[i + 1]);
  const open = i + 2;
  const close = matchParen(tokens, open);
  const columns = splitTopLevel(tokens.slice(open + 1, close)).map((part) => {
    let end = part.length;
    let descending = false;
    let collate: string | undefined;
    if (isWord(part[end - 1], 'ASC', 'DESC')) { descending = isWord(part[end - 1], 'DESC'); end -= 1; }
    if (end >= 2 && isWord(part[end - 2], 'COLLATE')) { collate = nameOf(part[end - 1]).toUpperCase(); end -= 2; }
    const expression = part.slice(0, end);
    return { tokens: expression, text: sourceText(sql, expression), collate, descending };
  });
  const index: ParsedIndex = { name, table, unique, columns };
  if (isWord(tokens[close + 1], 'WHERE')) {
    index.where = tokens.slice(close + 2);
    index.whereText = sourceText(sql, index.where);
  }
  return index;
}

export interface ParsedTrigger {
  name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  updateOf: string[];
  table: string;
  when?: Token[];
  body: Token[][];
}

function depthAt(tokens: Token[], index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if (isOp(tokens[i], '(')) depth += 1;
    if (isOp(tokens[i], ')')) depth -= 1;
  }
  return depth;
}

export function parseCreateTrigger(sql: string): ParsedTrigger {
  const tokens = tokenize(sql).filter((token, index, list) => !(index === list.length - 1 && isOp(token, ';')));
  let i = tokens.findIndex((token) => isWord(token, 'TRIGGER')) + 1;
  if (isWord(tokens[i], 'IF')) i += 3;
  let name = nameOf(tokens[i]);
  i += 1;
  if (isOp(tokens[i], '.')) { name = nameOf(tokens[i + 1]); i += 2; }
  let timing: ParsedTrigger['timing'] = 'BEFORE';
  if (isWord(tokens[i], 'BEFORE', 'AFTER')) { timing = tokens[i].value.toUpperCase() as 'BEFORE' | 'AFTER'; i += 1; }
  else if (isWord(tokens[i], 'INSTEAD')) { timing = 'INSTEAD OF'; i += 2; }
  const event = tokens[i]?.value.toUpperCase() as ParsedTrigger['event'];
  if (!['INSERT', 'UPDATE', 'DELETE'].includes(event)) throw new SqlParseError('Événement de déclencheur inconnu.');
  i += 1;
  const updateOf: string[] = [];
  if (isWord(tokens[i], 'OF')) {
    i += 1;
    while (i < tokens.length && !isWord(tokens[i], 'ON')) {
      if (!isOp(tokens[i], ',')) updateOf.push(nameOf(tokens[i]));
      i += 1;
    }
  }
  i += 1;
  let table = nameOf(tokens[i]);
  i += 1;
  if (isOp(tokens[i], '.')) { table = nameOf(tokens[i + 1]); i += 2; }
  if (isWord(tokens[i], 'FOR')) i += 3;
  let when: Token[] | undefined;
  if (isWord(tokens[i], 'WHEN')) {
    const begin = tokens.findIndex((token, index) => index > i && isWord(token, 'BEGIN') && depthAt(tokens, index) === 0);
    when = tokens.slice(i + 1, begin);
    i = begin;
  }
  if (!isWord(tokens[i], 'BEGIN') || !isWord(tokens[tokens.length - 1], 'END')) throw new SqlParseError('Corps BEGIN … END attendu.');
  const body = splitTopLevel(tokens.slice(i + 1, tokens.length - 1), ';').filter((statement) => statement.length);
  return { name, timing, event, updateOf, table, when, body };
}

export interface ParsedView {
  name: string;
  columns: string[];
  select: Token[];
}

export function parseCreateView(sql: string): ParsedView {
  const tokens = tokenize(sql).filter((token, index, list) => !(index === list.length - 1 && isOp(token, ';')));
  let i = tokens.findIndex((token) => isWord(token, 'VIEW')) + 1;
  if (isWord(tokens[i], 'IF')) i += 3;
  let name = nameOf(tokens[i]);
  i += 1;
  if (isOp(tokens[i], '.')) { name = nameOf(tokens[i + 1]); i += 2; }
  let columns: string[] = [];
  if (isOp(tokens[i], '(')) {
    const close = matchParen(tokens, i);
    columns = nameList(tokens.slice(i + 1, close));
    i = close + 1;
  }
  if (!isWord(tokens[i], 'AS')) throw new SqlParseError('AS attendu dans CREATE VIEW.');
  return { name, columns, select: tokens.slice(i + 1) };
}

/** Tables/views read or written by a statement (FROM lists incl. comma joins, JOIN, INTO, UPDATE targets), excluding CTE names. */
export function referencedRelations(tokens: Token[]): string[] {
  const names = new Set<string>();
  const ctes = new Set<string>();
  const fromDepths = new Set<number>();
  const clauseEnd = ['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'RETURNING', 'SET', 'VALUES', 'END'];
  let depth = 0;
  const relationAt = (j: number, into: boolean) => {
    const candidate = tokens[j];
    if (!candidate || !(candidate.kind === 'word' || candidate.kind === 'quoted')) return;
    if (candidate.kind === 'word' && ['SELECT', 'VALUES', 'WITH', 'SET', 'DEFAULT', 'OR'].includes(candidate.value.toUpperCase())) return;
    let name = candidate.value;
    let next = j + 1;
    if (isOp(tokens[next], '.')) { name = nameOf(tokens[next + 1]); next += 2; }
    // `name(` after FROM/JOIN is a table-valued function (json_each…), after INTO a column list.
    if (isOp(tokens[next], '(') && !into) return;
    names.add(name);
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isOp(token, '(')) { depth += 1; continue; }
    if (isOp(token, ')')) { fromDepths.delete(depth); depth -= 1; continue; }
    if (isOp(token, ';')) { fromDepths.clear(); depth = 0; continue; }
    if (isOp(token, ',')) {
      if (fromDepths.has(depth)) relationAt(i + 1, false);
      continue;
    }
    if ((token.kind === 'word' || token.kind === 'quoted') && isWord(tokens[i + 1], 'AS') && isOp(tokens[i + 2], '(')
      && (isWord(tokens[i - 1], 'WITH', 'RECURSIVE') || isOp(tokens[i - 1], ','))) ctes.add(token.value.toLowerCase());
    if (token.kind !== 'word') continue;
    const word = token.value.toUpperCase();
    if (clauseEnd.includes(word)) fromDepths.delete(depth);
    if (word === 'FROM') {
      fromDepths.add(depth);
      relationAt(i + 1, false);
    } else if (word === 'JOIN') relationAt(i + 1, false);
    else if (word === 'INTO') relationAt(i + 1, true);
    else if (word === 'UPDATE') relationAt(isWord(tokens[i + 1], 'OR') ? i + 3 : i + 1, false);
  }
  return [...names].filter((name) => !ctes.has(name.toLowerCase()));
}
