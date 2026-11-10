import { type Token, isOp, isWord, matchParen, splitTopLevel } from './sql.js';

/** PostgreSQL storage types produced by the converter (SQLite storage classes, widened). */
export type PgType = 'bigint' | 'double precision' | 'text' | 'bytea' | 'numeric';

export type HelperName = 'sqlite_json_valid' | 'sqlite_json_type' | 'sqlite_json_array_length' | 'sqlite_randomblob' | 'sqlite_raise';

export interface Problem {
  /** `error`: no faithful translation, the object must be skipped. `warning`: translated with a semantic difference. */
  level: 'error' | 'warning';
  message: string;
}

export type TranslateMode = 'default' | 'check' | 'index' | 'generated' | 'trigger' | 'view';

export interface TranslateContext {
  schema: string;
  mode: TranslateMode;
  /** lower-case name -> canonical column name (current table, or every table for triggers and views). */
  columns: Map<string, string>;
  /** lower-case column name -> PostgreSQL type (current table only). */
  columnTypes?: Map<string, PgType>;
  /** lower-case name -> canonical table or view name. */
  tables: Map<string, string>;
  helpers: Set<HelperName>;
  problems: Problem[];
  /** Column aliased by `rowid` in trigger bodies (INTEGER PRIMARY KEY tables). */
  rowidAlias?: string;
  /** Unqualified references to these columns become `NEW."col"` (trigger touch rewriting). */
  implicitNew?: Set<string>;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SQLite declared type -> PostgreSQL type, following SQLite's affinity rules (https://sqlite.org/datatype3.html). */
export function mapDeclaredType(declared: string): { type: PgType; warning?: string } {
  const upper = declared.toUpperCase();
  if (upper.includes('INT')) return { type: 'bigint' };
  if (/CHAR|CLOB|TEXT/.test(upper)) return { type: 'text' };
  if (upper.includes('BLOB')) return { type: 'bytea' };
  if (/REAL|FLOA|DOUB/.test(upper)) return { type: 'double precision' };
  if (!upper.trim()) return { type: 'text', warning: 'colonne sans type déclaré (affinité BLOB) exportée en text' };
  if (upper === 'ANY') return { type: 'text', warning: 'colonne STRICT de type ANY exportée en text' };
  if (/BOOL/.test(upper)) return { type: 'bigint' };
  if (/DATE|TIME|JSON|UUID/.test(upper)) return { type: 'text' };
  if (/NUMERIC|DECIMAL/.test(upper)) return { type: 'numeric' };
  return { type: 'text', warning: `type « ${declared} » (affinité NUMERIC) exporté en text` };
}

const PG_RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast', 'check', 'collate',
  'column', 'constraint', 'create', 'current_catalog', 'current_date', 'current_role', 'current_time', 'current_timestamp', 'current_user', 'default',
  'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in',
  'initially', 'intersect', 'into', 'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not', 'null', 'offset', 'on', 'only', 'or', 'order',
  'placing', 'primary', 'references', 'returning', 'select', 'session_user', 'some', 'symmetric', 'table', 'then', 'to', 'trailing', 'true', 'union',
  'unique', 'user', 'using', 'variadic', 'when', 'where', 'window', 'with']);

/** Words that are always SQL keywords in expressions/statements stored by SQLite. */
const KEYWORDS = new Set(['ALL', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'COLLATE', 'CROSS', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
  'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXISTS', 'FALSE', 'FROM', 'GLOB', 'GROUP', 'HAVING', 'IN', 'INNER',
  'INSERT', 'INTERSECT', 'INTO', 'IS', 'ISNULL', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'NATURAL', 'NOT', 'NOTNULL', 'NULL', 'OFFSET', 'ON', 'OR', 'ORDER',
  'OUTER', 'REGEXP', 'RIGHT', 'FULL', 'SELECT', 'SET', 'THEN', 'TRUE', 'UNION', 'UPDATE', 'USING', 'VALUES', 'WHEN', 'WHERE', 'WITH']);
/** Keywords SQLite also accepts as bare identifiers: a known column of that name wins. */
const SOFT_KEYWORDS = new Set(['CONFLICT', 'DO', 'NOTHING', 'FILTER', 'OVER', 'PARTITION', 'NULLS', 'FIRST', 'LAST', 'RECURSIVE', 'RETURNING',
  'MATCH', 'WINDOW', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW', 'EXCLUDED']);
/** Words that may be directly followed by `(` without being a function call. */
const NOT_FUNCTIONS = new Set([...KEYWORDS, 'CONFLICT', 'DO', 'FILTER', 'OVER', 'PARTITION', 'RETURNING', 'RECURSIVE', 'WINDOW', 'MATCH']);

const SAME_NAME_FUNCTIONS = new Set(['lower', 'upper', 'abs', 'coalesce', 'nullif', 'replace', 'ltrim', 'rtrim', 'count', 'sum', 'avg', 'sign',
  'octet_length', 'concat', 'concat_ws', 'ceil', 'ceiling', 'floor', 'ln', 'log', 'log10', 'power', 'sqrt', 'exp', 'mod', 'pi', 'trunc', 'degrees',
  'radians', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag',
  'lead', 'first_value', 'last_value', 'nth_value']);
const BOOLEAN_FUNCTIONS = new Set(['json_valid']);

const UTC_NOW = "(statement_timestamp() AT TIME ZONE 'UTC')";

interface Piece {
  text: string;
  glueLeft?: boolean;
  glueRight?: boolean;
}

function render(pieces: Piece[]): string {
  let out = '';
  let previous: Piece | undefined;
  for (const piece of pieces) {
    if (previous && !previous.glueRight && !piece.glueLeft) out += ' ';
    out += piece.text;
    previous = piece;
  }
  return out;
}

function problem(ctx: TranslateContext, level: Problem['level'], message: string) {
  if (!ctx.problems.some((item) => item.level === level && item.message === message)) ctx.problems.push({ level, message });
}

export function helperName(ctx: TranslateContext, helper: HelperName): string {
  ctx.helpers.add(helper);
  return `${quoteIdent(ctx.schema)}.${helper}`;
}

/** Bare identifiers stay unquoted (PostgreSQL folds them like SQLite ignores case) unless reserved. */
function plainIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PG_RESERVED.has(name.toLowerCase()) ? name : quoteIdent(name);
}

function columnRef(name: string, ctx: TranslateContext): string {
  const canonical = ctx.columns.get(name.toLowerCase());
  if (canonical && ctx.implicitNew?.has(canonical)) return `NEW.${quoteIdent(canonical)}`;
  return quoteIdent(canonical ?? name);
}

/** Type of a simple operand (column, literal) when it can be known statically. */
function operandType(tokens: Token[], ctx: TranslateContext): PgType | undefined {
  if (tokens.length !== 1) return undefined;
  const [token] = tokens;
  if (token.kind === 'string') return 'text';
  if (token.kind === 'blob') return 'bytea';
  if (token.kind === 'number') return /[.eE]/.test(token.value) && !/^0x/i.test(token.value) ? 'double precision' : 'bigint';
  if (token.kind === 'word' || token.kind === 'quoted') return ctx.columnTypes?.get(token.value.toLowerCase());
  return undefined;
}

export function translateExpression(tokens: Token[], ctx: TranslateContext): string {
  return render(translatePieces(tokens, ctx));
}

function translatePieces(tokens: Token[], ctx: TranslateContext): Piece[] {
  const out: Piece[] = [];
  const last = () => out[out.length - 1]?.text.toUpperCase();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];
    const previous = tokens[i - 1];
    if (token.kind === 'word' || token.kind === 'quoted') {
      const upper = token.value.toUpperCase();
      const lower = token.value.toLowerCase();
      if (isOp(previous, '.')) {
        const qualifier = tokens[i - 2];
        if (['ROWID', '_ROWID_', 'OID'].includes(upper) && isWord(qualifier, 'NEW', 'OLD')) {
          if (ctx.rowidAlias) out.push({ text: quoteIdent(ctx.rowidAlias) });
          else { problem(ctx, 'error', `référence ${upper} sans colonne INTEGER PRIMARY KEY`); out.push({ text: upper.toLowerCase() }); }
        } else out.push({ text: quoteIdent(ctx.columns.get(lower) ?? token.value) });
        continue;
      }
      if (token.kind === 'word' && isOp(next, '(') && !NOT_FUNCTIONS.has(upper) && !ctx.tables.has(lower)) {
        const close = matchParen(tokens, i + 1);
        const args = close === i + 2 ? [] : splitTopLevel(tokens.slice(i + 2, close));
        let text = translateFunction(token.value, args, ctx);
        i = close;
        if (BOOLEAN_FUNCTIONS.has(lower)) {
          // SQLite booleans are integers: `json_valid(x) = 1` must become a plain boolean test.
          const op = tokens[i + 1];
          const value = tokens[i + 2];
          if (isOp(op, '=', '==', '!=', '<>') && value?.kind === 'number' && ['0', '1'].includes(value.value)) {
            const truthy = (op.value === '=' || op.value === '==') === (value.value === '1');
            text = truthy ? text : `NOT ${text}`;
            i += 2;
          }
        }
        out.push({ text });
        continue;
      }
      if (isOp(next, '.')) {
        if (ctx.mode === 'trigger' && (upper === 'NEW' || upper === 'OLD') && token.kind === 'word') out.push({ text: upper });
        else {
          const table = ctx.tables.get(lower);
          out.push({ text: table ? quoteIdent(table) : token.kind === 'quoted' ? quoteIdent(token.value) : plainIdent(token.value) });
        }
        continue;
      }
      if (token.kind === 'quoted') {
        const canonical = ctx.columns.get(lower);
        out.push({ text: canonical ? columnRef(canonical, ctx) : quoteIdent(ctx.tables.get(lower) ?? token.value) });
        continue;
      }
      if (KEYWORDS.has(upper)) {
        i = translateKeyword(upper, tokens, i, ctx, out, last);
        continue;
      }
      if (ctx.columns.has(lower)) { out.push({ text: columnRef(token.value, ctx) }); continue; }
      if (ctx.tables.has(lower)) { out.push({ text: quoteIdent(ctx.tables.get(lower)!) }); continue; }
      if (SOFT_KEYWORDS.has(upper)) { out.push({ text: upper === 'EXCLUDED' ? 'excluded' : upper }); continue; }
      if (upper === 'NEW' || upper === 'OLD') { out.push({ text: upper }); continue; }
      out.push({ text: plainIdent(token.value) });
      continue;
    }
    if (token.kind === 'string') { out.push({ text: quoteLiteral(token.value) }); continue; }
    if (token.kind === 'number') {
      out.push({ text: /^0x/i.test(token.value) ? BigInt(token.value).toString() : token.value.startsWith('.') ? `0${token.value}` : token.value });
      continue;
    }
    if (token.kind === 'blob') { out.push({ text: `'\\x${token.value}'::bytea` }); continue; }
    if (token.kind === 'param') {
      problem(ctx, 'error', `paramètre ${token.value} inattendu`);
      out.push({ text: token.value });
      continue;
    }
    // Operators.
    switch (token.value) {
      case '(': out.push({ text: '(', glueRight: true }); break;
      case ')': out.push({ text: ')', glueLeft: true }); break;
      case ',': out.push({ text: ',', glueLeft: true }); break;
      case '.': out.push({ text: '.', glueLeft: true, glueRight: true }); break;
      case '==': out.push({ text: '=' }); break;
      case '!=': out.push({ text: '<>' }); break;
      case '->': case '->>':
        problem(ctx, 'error', `opérateur JSON ${token.value} (chemins SQLite) non traduit`);
        out.push({ text: token.value });
        break;
      case '+': case '-': {
        const unary = !previous || (previous.kind === 'op' && previous.value !== ')') || (previous.kind === 'word' && KEYWORDS.has(previous.value.toUpperCase()));
        out.push({ text: token.value, glueRight: unary });
        break;
      }
      default: out.push({ text: token.value });
    }
  }
  return out;
}

function translateKeyword(upper: string, tokens: Token[], i: number, ctx: TranslateContext, out: Piece[], last: () => string | undefined): number {
  const next = tokens[i + 1];
  switch (upper) {
    case 'TRUE': case 'FALSE':
      out.push({ text: last() === 'IS' || last() === 'IS NOT' ? upper : upper === 'TRUE' ? '1' : '0' });
      return i;
    case 'CURRENT_TIMESTAMP': out.push({ text: `to_char(${UTC_NOW}, 'YYYY-MM-DD HH24:MI:SS')` }); timeAllowed(ctx); return i;
    case 'CURRENT_DATE': out.push({ text: `to_char(${UTC_NOW}, 'YYYY-MM-DD')` }); timeAllowed(ctx); return i;
    case 'CURRENT_TIME': out.push({ text: `to_char(${UTC_NOW}, 'HH24:MI:SS')` }); timeAllowed(ctx); return i;
    case 'LIKE':
      out.push({ text: 'ILIKE' });
      // SQLite LIKE has no default escape character, PostgreSQL uses backslash.
      if (next?.kind === 'string' && next.value.includes('\\') && !isWord(tokens[i + 2], 'ESCAPE')) {
        out.push({ text: quoteLiteral(next.value) }, { text: "ESCAPE ''" });
        return i + 1;
      }
      return i;
    case 'REGEXP': out.push({ text: '~' }); return i;
    case 'GLOB': return translateGlob(tokens, i, ctx, out, false);
    case 'ISNULL': out.push({ text: 'IS NULL' }); return i;
    case 'NOTNULL': out.push({ text: 'IS NOT NULL' }); return i;
    case 'NOT':
      if (isWord(next, 'GLOB')) return translateGlob(tokens, i + 1, ctx, out, true);
      if (isWord(next, 'REGEXP')) { out.push({ text: '!~' }); return i + 1; }
      if (isWord(next, 'NULL') && last() !== 'IS') { out.push({ text: 'IS NOT NULL' }); return i + 1; }
      out.push({ text: 'NOT' });
      return i;
    case 'IS': {
      const negated = isWord(next, 'NOT');
      const subject = tokens[negated ? i + 2 : i + 1];
      if (isWord(subject, 'NULL', 'TRUE', 'FALSE', 'DISTINCT')) {
        out.push({ text: negated ? 'IS NOT' : 'IS' });
        if (isWord(subject, 'TRUE', 'FALSE')) problem(ctx, 'warning', 'IS TRUE/IS FALSE sur une valeur entière SQLite');
      } else out.push({ text: negated ? 'IS DISTINCT FROM' : 'IS NOT DISTINCT FROM' });
      return negated ? i + 1 : i;
    }
    case 'COLLATE': {
      const collation = (tokens[i + 1]?.value ?? '').toUpperCase();
      if (collation === 'BINARY') out.push({ text: 'COLLATE "C"' });
      else problem(ctx, 'warning', `COLLATE ${collation} ignoré (comparaison binaire dans PostgreSQL)`);
      return i + 1;
    }
    default:
      out.push({ text: upper });
      return i;
  }
}

/** `x GLOB 'pattern'` -> `x ~ '^regex$'` (case-sensitive, like GLOB). */
function translateGlob(tokens: Token[], i: number, ctx: TranslateContext, out: Piece[], negated: boolean): number {
  const pattern = tokens[i + 1];
  if (pattern?.kind !== 'string') {
    problem(ctx, 'error', 'GLOB avec un motif non littéral');
    out.push({ text: negated ? 'NOT GLOB' : 'GLOB' });
    return i;
  }
  out.push({ text: negated ? '!~' : '~' }, { text: quoteLiteral(globToRegex(pattern.value)) });
  return i + 1;
}

export function globToRegex(glob: string): string {
  let regex = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') { regex += '.*'; continue; }
    if (char === '?') { regex += '.'; continue; }
    if (char === '[') {
      let j = i + 1;
      let body = '';
      if (glob[j] === '^') { body += '^'; j += 1; }
      if (glob[j] === ']') { body += '\\]'; j += 1; }
      while (j < glob.length && glob[j] !== ']') {
        body += glob[j] === '\\' || glob[j] === '[' ? `\\${glob[j]}` : glob[j];
        j += 1;
      }
      if (j < glob.length) {
        regex += `[${body}]`;
        i = j;
        continue;
      }
    }
    regex += /[.+(){}|^$\\[\]]/.test(char) ? `\\${char}` : char;
  }
  return `${regex}$`;
}

function timeAllowed(ctx: TranslateContext) {
  if (ctx.mode === 'index' || ctx.mode === 'generated' || ctx.mode === 'check') {
    problem(ctx, 'error', 'fonction de date non immuable dans PostgreSQL');
  }
}

function literalOf(tokens: Token[] | undefined): string | undefined {
  return tokens?.length === 1 && tokens[0].kind === 'string' ? tokens[0].value : undefined;
}

const STRFTIME: Record<string, string> = {
  d: 'DD', f: 'SS.MS', H: 'HH24', j: 'DDD', m: 'MM', M: 'MI', S: 'SS', Y: 'YYYY', F: 'YYYY-MM-DD', T: 'HH24:MI:SS', R: 'HH24:MI',
  I: 'HH12', p: 'AM', P: 'am', u: 'ID', G: 'IYYY', V: 'IW', y: 'YY',
};

/** Converts a SQLite strftime() format into a PostgreSQL to_char() template, or undefined when impossible. */
export function strftimeToPg(format: string): string | undefined {
  let out = '';
  let literal = '';
  const flush = () => {
    if (!literal) return;
    // Letters and digits must be quoted or to_char may read them as template patterns.
    out += literal.replace(/[^\s\-:/.,;]+/g, (run) => `"${run.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    literal = '';
  };
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] !== '%') { literal += format[i]; continue; }
    const code = format[i + 1];
    i += 1;
    if (code === '%') { literal += '%'; continue; }
    const pattern = code ? STRFTIME[code] : undefined;
    if (!pattern) return undefined;
    flush();
    out += pattern;
  }
  flush();
  return out;
}

/** SQLite date/time functions -> to_char()/extract() on a UTC `timestamp without time zone`. */
function translateTime(name: string, args: Token[][], ctx: TranslateContext): string {
  let format: string | undefined;
  let offset = 0;
  if (name === 'strftime') {
    format = literalOf(args[0]);
    if (format === undefined) { problem(ctx, 'error', 'strftime() avec un format non littéral'); return 'NULL'; }
    offset = 1;
  }
  const value = args[offset];
  const modifiers = args.slice(offset + 1);
  const literals = modifiers.map(literalOf).map((item) => item?.trim().toLowerCase());
  let timestamp: string;
  let subsecond = false;
  if (!value || literalOf(value)?.toLowerCase() === 'now') {
    timeAllowed(ctx);
    timestamp = UTC_NOW;
  } else if (literals.includes('unixepoch')) {
    timestamp = `(to_timestamp(${translateExpression(value, ctx)}) AT TIME ZONE 'UTC')`;
  } else if (value.length === 1 && value[0].kind === 'number') {
    problem(ctx, 'error', `${name}() sur un jour julien numérique`);
    return 'NULL';
  } else {
    if (ctx.mode === 'index' || ctx.mode === 'generated') problem(ctx, 'error', `${name}() n’est pas immuable dans PostgreSQL (index ou colonne calculée)`);
    timestamp = `(${translateExpression(value, ctx)})::timestamp`;
    problem(ctx, 'warning', `${name}() sur une valeur : la conversion ::timestamp échoue (au lieu de renvoyer NULL) si le texte n’est pas une date valide`);
  }
  modifiers.forEach((modifier, index) => {
    const literal = literals[index];
    if (literal === undefined) {
      timestamp = `(${timestamp} + (${translateExpression(modifier, ctx)})::interval)`;
      problem(ctx, 'warning', `modificateur de date non littéral de ${name}() interprété comme un intervalle`);
      return;
    }
    const shift = /^([+-]?\s*\d+(?:\.\d+)?)\s+(year|month|day|hour|minute|second)s?$/.exec(literal);
    if (shift) timestamp = `(${timestamp} + interval ${quoteLiteral(`${shift[1].replace(/\s+/g, '')} ${shift[2]}`)})`;
    else if (/^start of (day|month|year)$/.test(literal)) timestamp = `date_trunc('${literal.slice(9)}', ${timestamp})`;
    else if (literal === 'subsec' || literal === 'subsecond') subsecond = true;
    else if (literal === 'utc') { /* values are already UTC */ }
    else if (literal !== 'unixepoch') problem(ctx, 'error', `modificateur de date « ${literal} » non traduit`);
  });
  switch (name) {
    case 'datetime': return `to_char(${timestamp}, '${subsecond ? 'YYYY-MM-DD HH24:MI:SS.MS' : 'YYYY-MM-DD HH24:MI:SS'}')`;
    case 'date': return `to_char(${timestamp}, 'YYYY-MM-DD')`;
    case 'time': return `to_char(${timestamp}, '${subsecond ? 'HH24:MI:SS.MS' : 'HH24:MI:SS'}')`;
    case 'julianday': return `(extract(epoch FROM ${timestamp})::double precision / 86400.0 + 2440587.5)`;
    case 'unixepoch': return subsecond ? `extract(epoch FROM ${timestamp})::double precision` : `floor(extract(epoch FROM ${timestamp}))::bigint`;
    default: {
      if (format === '%s') return `floor(extract(epoch FROM ${timestamp}))::bigint::text`;
      const template = strftimeToPg(format!);
      if (template === undefined) { problem(ctx, 'error', `format strftime « ${format} » non traduit`); return 'NULL'; }
      return `to_char(${timestamp}, ${quoteLiteral(template)})`;
    }
  }
}

/** Size tokens of `randomblob(n)`. */
function randomblobCall(tokens: Token[]): Token[] | undefined {
  if (!isWord(tokens[0], 'RANDOMBLOB') || !isOp(tokens[1], '(') || matchParen(tokens, 1) !== tokens.length - 1) return undefined;
  return tokens.slice(2, -1);
}

/** Size tokens of `hex(randomblob(n))`. */
function hexRandomblobCall(tokens: Token[]): Token[] | undefined {
  if (!isWord(tokens[0], 'HEX') || !isOp(tokens[1], '(') || matchParen(tokens, 1) !== tokens.length - 1) return undefined;
  return randomblobCall(tokens.slice(2, -1));
}

/** `json_extract(x, '$.a.b[0]')` path -> PostgreSQL text-array path `{a,b,0}`. */
function jsonPath(path: string | undefined): string | undefined {
  if (path === undefined || !/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/.test(path)) return undefined;
  const parts = [...path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)].map((match) => match[1] ?? match[2]);
  return `{${parts.join(',')}}`;
}

function translateFunction(rawName: string, args: Token[][], ctx: TranslateContext): string {
  const name = rawName.toLowerCase();
  const translated = () => args.map((arg) => translateExpression(arg, ctx));
  const call = (fn: string, values = translated()) => `${fn}(${values.join(', ')})`;
  switch (name) {
    case 'cast': {
      const inner = args[0] ?? [];
      const as = inner.findIndex((token, index) => isWord(token, 'AS') && depthBefore(inner, index) === 0);
      if (as === -1) { problem(ctx, 'error', 'CAST sans AS'); return 'NULL'; }
      const typeText = inner.slice(as + 1).map((token) => token.value).join(' ');
      return `CAST(${translateExpression(inner.slice(0, as), ctx)} AS ${mapDeclaredType(typeText).type})`;
    }
    case 'raise': {
      const kind = (args[0]?.[0]?.value ?? '').toUpperCase();
      if (kind === 'IGNORE' || args.length < 2) { problem(ctx, 'error', 'RAISE(IGNORE) dans une expression'); return 'NULL'; }
      return `${helperName(ctx, 'sqlite_raise')}(${translateExpression(args[1], ctx)})`;
    }
    case 'length': {
      const type = operandType(args[0] ?? [], ctx);
      if (type === 'bytea') return call('octet_length');
      if (type && type !== 'text') return `length((${translateExpression(args[0], ctx)})::text)`;
      return call('length');
    }
    case 'substr': case 'substring': return call('substr');
    case 'trim': return call('btrim');
    case 'ifnull': return call('coalesce');
    case 'instr': return call('strpos');
    case 'unicode': return call('ascii');
    case 'char': return translated().map((value) => `chr(${value})`).join(' || ') || "''";
    case 'quote': return call('quote_nullable');
    case 'pow': return call('power');
    case 'log2': return `log(2, ${translated()[0]})`;
    case 'likely': case 'unlikely': case 'likelihood': return translated()[0];
    case 'iif': {
      const [condition, whenTrue, whenFalse] = translated();
      return `CASE WHEN ${condition} THEN ${whenTrue} ELSE ${whenFalse ?? 'NULL'} END`;
    }
    case 'min': case 'max':
      if (args.length <= 1) return call(name);
      problem(ctx, 'warning', `${name}() à plusieurs arguments traduit en ${name === 'min' ? 'least' : 'greatest'}() (ignore les NULL)`);
      return call(name === 'min' ? 'least' : 'greatest');
    case 'total': return `coalesce(sum(${translated()[0]}), 0)::double precision`;
    case 'group_concat': case 'string_agg': {
      const [first = [], separator] = args;
      const distinct = isWord(first[0], 'DISTINCT');
      const value = translateExpression(distinct ? first.slice(1) : first, ctx);
      return `string_agg(${distinct ? 'DISTINCT ' : ''}(${value})::text, ${separator ? translateExpression(separator, ctx) : "','"})`;
    }
    case 'round':
      if (args.length < 2) return call('round');
      return `round((${translateExpression(args[0], ctx)})::numeric, ${translateExpression(args[1], ctx)})::double precision`;
    case 'random': return 'floor(random() * 9.0e18)::bigint';
    case 'randomblob': return `${helperName(ctx, 'sqlite_randomblob')}(${translated()[0]})`;
    case 'hex': {
      const size = args.length === 1 ? randomblobCall(args[0]) : undefined;
      if (size) return `upper(encode(${helperName(ctx, 'sqlite_randomblob')}(${translateExpression(size, ctx)}), 'hex'))`;
      const type = operandType(args[0] ?? [], ctx);
      if (type === 'bytea') return `upper(encode(${translated()[0]}, 'hex'))`;
      return `upper(encode(convert_to((${translated()[0]})::text, 'UTF8'), 'hex'))`;
    }
    case 'lower': {
      const size = args.length === 1 ? hexRandomblobCall(args[0]) : undefined;
      if (size) return `encode(${helperName(ctx, 'sqlite_randomblob')}(${translateExpression(size, ctx)}), 'hex')`;
      return call('lower');
    }
    case 'typeof': {
      const arg = args[0] ?? [];
      const type = arg.length === 1 && (arg[0].kind === 'word' || arg[0].kind === 'quoted') ? ctx.columnTypes?.get(arg[0].value.toLowerCase()) : undefined;
      const sqliteType = { bigint: 'integer', 'double precision': 'real', text: 'text', bytea: 'blob', numeric: undefined }[type ?? 'numeric'];
      if (!sqliteType) { problem(ctx, 'error', 'typeof() non traduit (type dynamique SQLite)'); return 'NULL'; }
      return `CASE WHEN ${translateExpression(arg, ctx)} IS NULL THEN 'null' ELSE '${sqliteType}' END`;
    }
    case 'json_valid': {
      const type = operandType(args[0] ?? [], ctx);
      const value = translated()[0];
      return `${helperName(ctx, 'sqlite_json_valid')}(${type && type !== 'text' ? `(${value})::text` : value})`;
    }
    case 'json_extract': {
      const path = jsonPath(literalOf(args[1]));
      if (args.length !== 2 || !path) { problem(ctx, 'error', 'json_extract() avec un chemin non littéral ou multiple'); return 'NULL'; }
      problem(ctx, 'warning', 'json_extract() traduit en #>> : le résultat est du texte (SQLite renvoie un type SQL)');
      return `((${translated()[0]})::jsonb #>> ${quoteLiteral(path)})`;
    }
    case 'json_array_length': case 'json_type': {
      const path = args[1] ? jsonPath(literalOf(args[1])) : '{}';
      if (args.length > 2 || !path) { problem(ctx, 'error', `${name}() avec un chemin non littéral`); return 'NULL'; }
      const type = operandType(args[0] ?? [], ctx);
      const value = translated()[0];
      const helper = helperName(ctx, name === 'json_type' ? 'sqlite_json_type' : 'sqlite_json_array_length');
      return `${helper}(${type && type !== 'text' ? `(${value})::text` : value}${path === '{}' ? '' : `, ${quoteLiteral(path)}`})`;
    }
    case 'json_object': case 'json_array':
      if (!args.length) return name === 'json_object' ? "'{}'" : "'[]'";
      problem(ctx, 'error', `${name}() avec arguments non traduit (format texte différent)`);
      return 'NULL';
    case 'strftime': case 'datetime': case 'date': case 'time': case 'julianday': case 'unixepoch':
      return translateTime(name, args, ctx);
    default:
      if (SAME_NAME_FUNCTIONS.has(name)) return call(name);
      problem(ctx, 'error', `fonction SQLite ${name}() non traduite`);
      return call(name);
  }
}

function depthBefore(tokens: Token[], index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if (isOp(tokens[i], '(')) depth += 1;
    if (isOp(tokens[i], ')')) depth -= 1;
  }
  return depth;
}

/** SQL bodies of the helper functions referenced by translated expressions. */
export function helperDefinitions(schema: string, helpers: Set<HelperName>): { name: HelperName; sql: string }[] {
  const s = quoteIdent(schema);
  const definitions: Record<HelperName, string> = {
    sqlite_json_valid: `CREATE OR REPLACE FUNCTION ${s}.sqlite_json_valid(document text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $alpha$
BEGIN
  IF document IS NULL THEN RETURN NULL; END IF;
  PERFORM document::json;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$alpha$`,
    // SQLite json_type(): integer/real/text/true/false/null/array/object; NULL for SQL NULL, a missing path or malformed JSON.
    sqlite_json_type: `CREATE OR REPLACE FUNCTION ${s}.sqlite_json_type(document text, path text[] DEFAULT '{}') RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $alpha$
DECLARE
  value json;
BEGIN
  IF document IS NULL THEN RETURN NULL; END IF;
  BEGIN
    value := document::json #> path;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF value IS NULL THEN RETURN NULL; END IF;
  RETURN CASE json_typeof(value)
    WHEN 'string' THEN 'text'
    WHEN 'boolean' THEN btrim(value::text)
    WHEN 'number' THEN CASE WHEN value::text ~ '[.eE]' THEN 'real' ELSE 'integer' END
    ELSE json_typeof(value)
  END;
END;
$alpha$`,
    // SQLite json_array_length(): 0 for non-arrays; NULL for SQL NULL, a missing path or malformed JSON.
    sqlite_json_array_length: `CREATE OR REPLACE FUNCTION ${s}.sqlite_json_array_length(document text, path text[] DEFAULT '{}') RETURNS bigint
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $alpha$
DECLARE
  value json;
BEGIN
  IF document IS NULL THEN RETURN NULL; END IF;
  BEGIN
    value := document::json #> path;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF value IS NULL THEN RETURN NULL; END IF;
  RETURN CASE WHEN json_typeof(value) = 'array' THEN json_array_length(value) ELSE 0 END;
END;
$alpha$`,
    sqlite_randomblob: `CREATE OR REPLACE FUNCTION ${s}.sqlite_randomblob(size bigint) RETURNS bytea
LANGUAGE sql VOLATILE PARALLEL SAFE AS $alpha$
  SELECT substring(decode(string_agg(replace(gen_random_uuid()::text, '-', ''), ''), 'hex') FROM 1 FOR greatest(size, 1)::int)
  FROM generate_series(1, ceil(greatest(size, 1) / 16.0)::int)
$alpha$`,
    sqlite_raise: `CREATE OR REPLACE FUNCTION ${s}.sqlite_raise(raise_message text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $alpha$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23000', MESSAGE = raise_message;
END;
$alpha$`,
  };
  return [...helpers].sort().map((name) => ({ name, sql: definitions[name] }));
}

const BOOLEAN_WORDS = new Set(['AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'GLOB', 'REGEXP', 'MATCH', 'IS', 'ISNULL', 'NOTNULL', 'EXISTS']);
const BOOLEAN_OPS = new Set(['=', '==', '!=', '<>', '<', '>', '<=', '>=']);

/** Whether a SQLite expression is a predicate (PostgreSQL requires boolean, SQLite accepts any number). */
export function isBooleanExpression(tokens: Token[]): boolean {
  if (!tokens.length) return false;
  if (isOp(tokens[0], '(') && matchParen(tokens, 0) === tokens.length - 1) return isBooleanExpression(tokens.slice(1, -1));
  if (tokens[0].kind === 'word' && BOOLEAN_FUNCTIONS.has(tokens[0].value.toLowerCase()) && isOp(tokens[1], '(') && matchParen(tokens, 1) === tokens.length - 1) return true;
  let depth = 0;
  let caseDepth = 0;
  for (const token of tokens) {
    if (isOp(token, '(')) depth += 1;
    else if (isOp(token, ')')) depth -= 1;
    else if (depth === 0 && isWord(token, 'CASE')) caseDepth += 1;
    else if (depth === 0 && caseDepth > 0 && isWord(token, 'END')) caseDepth -= 1;
    else if (depth === 0 && caseDepth === 0) {
      if (token.kind === 'op' && BOOLEAN_OPS.has(token.value)) return true;
      if (token.kind === 'word' && BOOLEAN_WORDS.has(token.value.toUpperCase())) return true;
    }
  }
  return false;
}

/** Translates a CHECK / WHERE / WHEN predicate, turning SQLite numeric truth values into a boolean test. */
export function translateCondition(tokens: Token[], ctx: TranslateContext): string {
  const sql = translateExpression(tokens, ctx);
  return isBooleanExpression(tokens) ? sql : `(${sql}) <> 0`;
}
