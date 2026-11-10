import { type ParsedTrigger, type Token, isOp, isWord, matchParen, nameOf, referencedRelations, splitTopLevel } from './sql.js';
import { type HelperName, type TranslateContext, quoteIdent, translateCondition, translateExpression } from './translate.js';

export interface TriggerTarget {
  name: string;
  isView: boolean;
  columns: string[];
  primaryKey: string[];
  /** Ordinary rowid table (not WITHOUT ROWID, not a view). */
  rowidTable: boolean;
  rowidAlias?: string;
}

export interface TriggerScope {
  schema: string;
  columns: Map<string, string>;
  tables: Map<string, string>;
  helpers: Set<HelperName>;
}

export interface ConvertedTrigger {
  functionName: string;
  functionSql: string;
  triggers: { name: string; table: string; sql: string }[];
  /** Pattern recognised: `guard` (RAISE), `touch` (column refresh), `generic` (statement-by-statement translation). */
  pattern: 'guard' | 'touch' | 'generic';
  notes: string[];
}

/** SQLSTATE used for SQLite RAISE(ABORT|FAIL|ROLLBACK, ...): SQLite reports them as constraint errors. */
export const TRIGGER_RAISE_SQLSTATE = '23000';

type Step =
  | { kind: 'raise'; code: string; unconditional: boolean }
  | { kind: 'touch'; code: string }
  | { kind: 'generic'; code: string; modifiesSelf: boolean };

export class TriggerTranslationError extends Error {}

/** Postgres truncates identifiers to 63 bytes: shorten with a stable hash suffix instead. */
export function pgName(base: string, used?: Set<string>): string {
  let name = base;
  if (Buffer.byteLength(name) > 63) {
    let hash = 0;
    for (const char of base) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
    const suffix = `_${hash.toString(36)}`;
    name = base;
    while (Buffer.byteLength(name) + suffix.length > 63) name = name.slice(0, -1);
    name += suffix;
  }
  if (used) {
    let candidate = name;
    for (let n = 1; used.has(candidate.toLowerCase()); n += 1) candidate = `${name.slice(0, 60 - String(n).length)}_${n}`;
    used.add(candidate.toLowerCase());
    name = candidate;
  }
  return name;
}

function topLevelWord(tokens: Token[], word: string, from = 0): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i += 1) {
    if (isOp(tokens[i], '(')) depth += 1;
    else if (isOp(tokens[i], ')')) depth -= 1;
    else if (depth === 0 && isWord(tokens[i], word)) return i;
  }
  return -1;
}

function raiseCall(tokens: Token[]): { kind: string; message: Token[]; end: number } | undefined {
  if (!isWord(tokens[0], 'RAISE') || !isOp(tokens[1], '(')) return undefined;
  const close = matchParen(tokens, 1);
  const args = splitTopLevel(tokens.slice(2, close));
  return { kind: (args[0]?.[0]?.value ?? '').toUpperCase(), message: args[1] ?? [], end: close };
}

export function convertTrigger(trigger: ParsedTrigger, target: TriggerTarget, scope: TriggerScope, usedNames: Set<string>): ConvertedTrigger {
  const ctx: TranslateContext = {
    schema: scope.schema, mode: 'trigger', columns: scope.columns, tables: scope.tables, helpers: scope.helpers, problems: [], rowidAlias: target.rowidAlias,
  };
  const s = quoteIdent(scope.schema);
  const before = trigger.timing !== 'AFTER';
  const notes: string[] = [];

  const raise = (kind: string, message: Token[]): string => {
    if (kind === 'IGNORE') {
      if (!before) throw new TriggerTranslationError('RAISE(IGNORE) dans un déclencheur AFTER');
      return 'RETURN NULL;';
    }
    return `RAISE EXCEPTION USING ERRCODE = '${TRIGGER_RAISE_SQLSTATE}', MESSAGE = ${translateExpression(message, ctx)};`;
  };

  const guard = (tokens: Token[]): Step | undefined => {
    if (!isWord(tokens[0], 'SELECT')) return undefined;
    const call = raiseCall(tokens.slice(1));
    if (call) {
      const rest = tokens.slice(call.end + 2);
      let condition: string | undefined;
      if (rest.length && isWord(rest[0], 'WHERE') && topLevelWord(rest, 'FROM') === -1) condition = translateCondition(rest.slice(1), ctx);
      else if (rest.length && isWord(rest[0], 'FROM')) condition = `EXISTS (SELECT 1 ${translateExpression(rest, ctx)})`;
      else if (rest.length) return undefined;
      const action = raise(call.kind, call.message);
      return { kind: 'raise', code: condition ? `IF ${condition} THEN\n    ${action}\n  END IF;` : action, unconditional: !condition };
    }
    // SELECT CASE WHEN cond THEN RAISE(...) [WHEN ...] [ELSE NULL] END
    if (!isWord(tokens[1], 'CASE') || !isWord(tokens[2], 'WHEN') || !isWord(tokens[tokens.length - 1], 'END')) return undefined;
    const branches: { condition: Token[]; action: Token[] }[] = [];
    let depth = 0;
    let caseDepth = 0;
    let marker = 2;
    let section: 'when' | 'then' | 'else' = 'when';
    let condition: Token[] = [];
    for (let i = 3; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (isOp(token, '(')) depth += 1;
      if (isOp(token, ')')) depth -= 1;
      if (depth !== 0) continue;
      if (isWord(token, 'CASE')) { caseDepth += 1; continue; }
      if (caseDepth > 0) { if (isWord(token, 'END')) caseDepth -= 1; continue; }
      if (isWord(token, 'THEN', 'WHEN', 'ELSE', 'END')) {
        const part = tokens.slice(marker + 1, i);
        if (section === 'when') condition = part;
        else if (section === 'then') branches.push({ condition, action: part });
        else if (!(part.length === 1 && (isWord(part[0], 'NULL') || part[0].kind === 'number'))) return undefined;
        section = isWord(token, 'THEN') ? 'then' : isWord(token, 'WHEN') ? 'when' : 'else';
        marker = i;
        if (isWord(token, 'END') && i !== tokens.length - 1) return undefined;
      }
    }
    const code: string[] = [];
    for (const [index, branch] of branches.entries()) {
      const call = raiseCall(branch.action);
      if (!call || call.end !== branch.action.length - 1) return undefined;
      code.push(`${index === 0 ? 'IF' : 'ELSIF'} ${translateCondition(branch.condition, ctx)} THEN\n    ${raise(call.kind, call.message)}`);
    }
    return branches.length ? { kind: 'raise', code: `${code.join('\n  ')}\n  END IF;`, unconditional: false } : undefined;
  };

  const touch = (tokens: Token[]): Step | undefined => {
    if (trigger.event === 'DELETE' || target.isView || !isWord(tokens[0], 'UPDATE') || !isWord(tokens[2], 'SET')) return undefined;
    if (nameOf(tokens[1]).toLowerCase() !== target.name.toLowerCase()) return undefined;
    const where = topLevelWord(tokens, 'WHERE', 3);
    if (where === -1) return undefined;
    const keys = new Set<string>();
    if (target.primaryKey.length === 1) keys.add(target.primaryKey[0].toLowerCase());
    if (target.rowidTable) ['rowid', '_rowid_', 'oid'].forEach((key) => keys.add(key));
    const condition = tokens.slice(where + 1);
    const isKey = (token: Token | undefined) => !!token && (token.kind === 'word' || token.kind === 'quoted') && keys.has(token.value.toLowerCase());
    const isNewKey = (part: Token[]) => part.length === 3 && isWord(part[0], 'NEW') && isOp(part[1], '.') && isKey(part[2]);
    const matches = condition.length === 5 && isOp(condition[1], '=', '==')
      ? (isKey(condition[0]) && isNewKey(condition.slice(2))) || (isNewKey(condition.slice(0, 3)) && isOp(condition[3], '=', '==') && isKey(condition[4]))
      : condition.length === 5 && isNewKey(condition.slice(0, 3)) && isOp(condition[3], '=', '==') && isKey(condition[4]);
    if (!matches) return undefined;
    const columns = new Map(target.columns.map((column) => [column.toLowerCase(), column]));
    const lines: string[] = [];
    for (const assignment of splitTopLevel(tokens.slice(3, where))) {
      const column = assignment[0] && (assignment[0].kind === 'word' || assignment[0].kind === 'quoted') ? columns.get(assignment[0].value.toLowerCase()) : undefined;
      if (!column || !isOp(assignment[1], '=', '==') || assignment.some((token) => isWord(token, 'SELECT'))) return undefined;
      const touchCtx: TranslateContext = { ...ctx, implicitNew: new Set(target.columns) };
      lines.push(`NEW.${quoteIdent(column)} := ${translateExpression(assignment.slice(2), touchCtx)};`);
    }
    return { kind: 'touch', code: lines.join('\n  ') };
  };

  const generic = (tokens: Token[]): Step => {
    const head = (tokens[0]?.value ?? '').toUpperCase();
    let body = tokens;
    let suffix = '';
    let modified: Token | undefined;
    if (head === 'INSERT' || head === 'REPLACE') {
      if (head === 'REPLACE') throw new TriggerTranslationError('REPLACE INTO non traduit (préciser ON CONFLICT … DO UPDATE)');
      if (isWord(tokens[1], 'OR')) {
        const action = (tokens[2]?.value ?? '').toUpperCase();
        if (action === 'REPLACE') throw new TriggerTranslationError('INSERT OR REPLACE non traduit (préciser ON CONFLICT … DO UPDATE)');
        if (action === 'IGNORE') suffix = ' ON CONFLICT DO NOTHING';
        body = [tokens[0], ...tokens.slice(3)];
      }
      modified = body[2];
    } else if (head === 'UPDATE') {
      if (isWord(tokens[1], 'OR')) {
        if (!isWord(tokens[2], 'ABORT', 'FAIL', 'ROLLBACK')) throw new TriggerTranslationError(`UPDATE OR ${tokens[2]?.value} non traduit`);
        body = [tokens[0], ...tokens.slice(3)];
      }
      modified = body[1];
    } else if (head === 'DELETE') {
      modified = tokens[2];
    } else if (head !== 'SELECT') {
      throw new TriggerTranslationError(`instruction ${head} non prise en charge dans un déclencheur`);
    }
    const code = head === 'SELECT' ? `PERFORM ${translateExpression(tokens.slice(1), ctx)};` : `${translateExpression(body, ctx)}${suffix};`;
    return { kind: 'generic', code, modifiesSelf: !!modified && nameOf(modified).toLowerCase() === target.name.toLowerCase() };
  };

  for (const relation of [...trigger.body.flatMap((statement) => referencedRelations(statement)), ...referencedRelations(trigger.when ?? [])]) {
    if (!scope.tables.has(relation.toLowerCase())) throw new TriggerTranslationError(`table ou vue « ${relation} » absente de l’export`);
  }
  let steps = trigger.body.map((statement) => guard(statement) ?? touch(statement) ?? generic(statement));
  if (steps.some((step) => step.kind === 'generic') && steps.some((step) => step.kind === 'touch')) {
    steps = trigger.body.map((statement) => guard(statement) ?? generic(statement));
  }
  const errors = ctx.problems.filter((item) => item.level === 'error');
  if (errors.length) throw new TriggerTranslationError(errors.map((item) => item.message).join(' ; '));
  notes.push(...ctx.problems.map((item) => item.message));

  const pattern: ConvertedTrigger['pattern'] = steps.some((step) => step.kind === 'generic') ? 'generic' : steps.some((step) => step.kind === 'touch') ? 'touch' : 'guard';
  // A SQLite AFTER trigger that re-updates the same row becomes a BEFORE trigger assigning NEW (no recursive UPDATE).
  const timing = pattern === 'touch' && trigger.timing === 'AFTER' ? 'BEFORE' : trigger.timing;
  const returnValue = timing === 'AFTER' ? 'NULL' : trigger.event === 'DELETE' ? 'OLD' : 'NEW';
  let when = trigger.when ? translateCondition(trigger.when, ctx) : undefined;
  const lateErrors = ctx.problems.filter((item) => item.level === 'error');
  if (lateErrors.length) throw new TriggerTranslationError(lateErrors.map((item) => item.message).join(' ; '));
  const lines = steps.map((step) => step.code);
  // PostgreSQL forbids subqueries in WHEN and WHEN on INSTEAD OF triggers: test the condition in the function instead.
  if (when && (trigger.timing === 'INSTEAD OF' || trigger.when!.some((token) => isWord(token, 'SELECT')))) {
    lines.unshift(`IF NOT coalesce((${when}), false) THEN\n    RETURN ${trigger.timing === 'INSTEAD OF' ? 'NULL' : returnValue};\n  END IF;`);
    when = undefined;
  }
  if (steps.some((step) => step.kind === 'generic' && step.modifiesSelf)) {
    // SQLite runs with recursive_triggers=OFF: a trigger never re-fires from its own statements.
    when = when ? `(${when}) AND pg_trigger_depth() < 1` : 'pg_trigger_depth() < 1';
    notes.push('garde pg_trigger_depth() < 1 ajoutée (recursive_triggers désactivé dans SQLite)');
  }

  const functionName = pgName(`${trigger.name}_fn`, usedNames);
  const functionSql = `CREATE OR REPLACE FUNCTION ${s}.${quoteIdent(functionName)}() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, ${s} AS $alpha$
BEGIN
  ${lines.join('\n  ')}
  RETURN ${returnValue};
END;
$alpha$`;
  const columns = new Map(target.columns.map((column) => [column.toLowerCase(), column]));
  const of = trigger.updateOf.length ? ` OF ${trigger.updateOf.map((column) => quoteIdent(columns.get(column.toLowerCase()) ?? column)).join(', ')}` : '';
  const triggers = [{
    name: trigger.name,
    table: target.name,
    sql: `CREATE TRIGGER ${quoteIdent(trigger.name)} ${timing} ${trigger.event}${of} ON ${s}.${quoteIdent(target.name)} FOR EACH ROW${when ? ` WHEN (${when})` : ''} EXECUTE FUNCTION ${s}.${quoteIdent(functionName)}()`,
  }];
  const first = steps[0];
  if (trigger.event === 'DELETE' && !target.isView && !trigger.when && steps.length === 1 && first.kind === 'raise' && first.unconditional && !first.code.startsWith('RETURN')) {
    // DELETE is forbidden unconditionally: TRUNCATE (which bypasses row triggers in PostgreSQL) must be too.
    const name = pgName(`${trigger.name}_truncate`);
    triggers.push({ name, table: target.name, sql: `CREATE TRIGGER ${quoteIdent(name)} BEFORE TRUNCATE ON ${s}.${quoteIdent(target.name)} FOR EACH STATEMENT EXECUTE FUNCTION ${s}.${quoteIdent(functionName)}()` });
  }
  return { functionName, functionSql, triggers, pattern, notes };
}
