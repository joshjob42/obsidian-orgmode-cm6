import { buildParser } from '@lezer/generator'
import { SyntaxNode, Tree } from "@lezer/common"
import { OrgmodeTask, StatusType } from 'org-tasks';
import { grammarFile } from "./boolean_expression_generated_grammar";
import { OrgmodePluginSettings } from 'settings';

export interface ConditionResolver {
  // interface needed to use moment.js with obsidian
  resolve: (value: ConditionValue, task: OrgmodeTask) => string | number
}

const BooleanExpressionParser = buildParser(grammarFile.toString())

export function parseBooleanExpression(boolExpr: string): { tree: Tree, normalizedExpr: string } {
  if (boolExpr.match(/[&|]/)) {
    throw Error('Special characters "&" / "|" are not accepted in expression, use "and" / "or" instead')
  }
  boolExpr = boolExpr.replace(/ and /gi, " & ").replace(/ or /gi, ' | ')
  try {
    BooleanExpressionParser.configure({strict: true}).parse(boolExpr)
  } catch(e) {
    throw Error(`query is not a valid expression ${e}`)
  }
  return {tree: BooleanExpressionParser.parse(boolExpr), normalizedExpr: boolExpr }
}


function parseExpTime(timeVal: string): [number, string] {
  if (timeVal === "today" || timeVal === "tod") {
    timeVal = "0d"
  }
  if (timeVal === "tomorrow" || timeVal === "tmrw" || timeVal === "tom") {
    timeVal = "1d"
  }
  if (timeVal === "yesterday") {
    timeVal = "-1d"
  }
  if (timeVal === "now") {
    timeVal = "0d"
  }

  let intervalStr = timeVal.slice(timeVal.length-1)
  if (intervalStr === "m") {
    // "m" is minutes for Moment.js
    // we want month "M"
    intervalStr = "M"
  }
  const nb = +timeVal.slice(0, timeVal.length-1)
  return [nb, intervalStr]
}

function extractTaskTime(exp_key: string): ConditionValue  {
  let dateToEval = ""
  if (exp_key == "d") {
    dateToEval = "task.deadline"
  } else if (exp_key == "c") {
    dateToEval = "task.closed"
  } else if (exp_key == "s") {
    dateToEval = "task.scheduled"
  }
  if (!dateToEval) {
    return null
  }
  return {"evalDateStartOfDay": dateToEval}
}

export type ConditionValue =
  | { text: string, date?: never, duration?: never, eval?: never }
  | { duration: [number, string], text?: never, state?: never, eval?: never }
  | { eval: string, date?: never, text?: never, duration?: never }
  | { evalDateStartOfDay: string, date?: never, text?: never, duration?: never }
  | { evalDate: string, date?: never, text?: never, duration?: never }
export type Condition = [ConditionValue, Neg, ExpOp, ConditionValue]
export type SortOrderChoice =
  //'+notebook' | '-notebook'
  // | '+title' | '-title'
  | '+scheduled' | '-scheduled'
  | '+deadline' | '-deadline'
  // | '+event' | '-event'
  | '+closed' | '-closed'
  // | '+created' | '-created'
  | '+priority' | '-priority'
  | '+status' | '-status'  // state in orgzly query
export type SortOrder = { sort: SortOrderChoice[] }
export type IntermediateRepr =
  []  // all tasks
  | Condition
  | SortOrder
  | { and: IntermediateRepr[] }
  | { or: IntermediateRepr[] }
export enum ExpOp {
  EQ="eq",
  NE="ne",
  LT="lt",
  LE="le",
  GT="gt",
  GE="ge",
}
export type Neg = "is" | "not"


function parseCondition(conditionStr: string, settings: OrgmodePluginSettings): Condition | SortOrder {
  try {
    let negated: Neg = "is"
    if (conditionStr.startsWith(".")) {
      negated = "not"
      conditionStr = conditionStr.slice(1)
    }
    const words = conditionStr.split(".")
    const exp_key = words[0]

    if (negated === "not" && ["s", "d", "d", "c", "cr"].includes(exp_key)) {
      throw Error(`Negation with leading '.' not supported in query for OP "${exp_key}"`)
    }

    if (exp_key === "o") {
      const sortKey = words[1]
      const ascDescSymbol = (negated === "is") ? "+" : "-"
      if (['b', 'book', 'notebook'].includes(sortKey)) {
        throw Error(`Could not parse condition "${conditionStr}"`)
        // return {"sort": [`${ascDescSymbol}notebook`]}
      } else if (['t', 'title'].includes(sortKey)) {
        throw Error(`Could not parse condition "${conditionStr}"`)
        // return {"sort": [`${ascDescSymbol}title`]}
      } else if (['s', 'sched', 'scheduled'].includes(sortKey)) {
        return {"sort": [`${ascDescSymbol}scheduled`]}
      } else if (['d', 'dead', 'deadline'].includes(sortKey)) {
        return {"sort": [`${ascDescSymbol}deadline`]}
      } else if (['e', 'event'].includes(sortKey)) {
        throw Error(`Could not parse condition "${conditionStr}"`)
        // return {"sort": [`${ascDescSymbol}event`]}
      } else if (['c', 'close', 'closed'].includes(sortKey)) {
        return {"sort": [`${ascDescSymbol}closed`]}
      } else if (['cr', 'created'].includes(sortKey)) {
        throw Error(`Could not parse condition "${conditionStr}"`)
        // return {"sort": [`${ascDescSymbol}created`]}
      } else if (['p', 'pri', 'prio', 'priority'].includes(sortKey)) {
        return {"sort": [`${ascDescSymbol}priority`]}
      } else if (['st', 'state'].includes(sortKey)) {
         return {"sort": [`${ascDescSymbol}status`]}
      }
    }
    if (["s", "d", "c"].includes(exp_key)) {
      let exp_op = ExpOp.EQ
      if (["s", "d", "cr"].includes(exp_key)) {
        // Default value for s, d and cr is le
        // Default value for c is eq
        exp_op = ExpOp.LE
      }
      let exp_timeVal = ""
      if (words.length == 2) {
        exp_timeVal = words[1]
      } else if (words.length == 3) {
        if (!Object.values(ExpOp).includes(words[1] as any)) {
          throw Error(`Condition "${conditionStr}" is not valid`)
        }
        exp_op = words[1] as ExpOp
        exp_timeVal = words[2]
      }
      const dateExpr = extractTaskTime(exp_key)
      if (exp_timeVal === 'none' || exp_timeVal === 'no') {
        return [dateExpr, negated, exp_op, {'text': null}]
      }
      const [nb, intervalStr] = parseExpTime(exp_timeVal)
      return [dateExpr, negated, exp_op, {'duration': [nb, intervalStr]}]
    } else if (exp_key === "i") {
      const todoDoneKeywords = [...settings.todoKeywords, ...settings.doneKeywords]
      if (!todoDoneKeywords.map(x => x.toLowerCase()).includes(words[1].toLowerCase())) {
        throw Error(`Condition "${conditionStr}" is not valid, todo keyword "${words[1]}" not in settings`)
      }
      const stateRef = words[1].toUpperCase()
      return [{'eval': `task.status`}, negated, ExpOp.EQ, {'text': stateRef}]
    } else if (exp_key === "it") {
      if (!Object.values(StatusType).includes(words[1].toUpperCase() as any)) {
        throw Error(`Condition "${conditionStr}" is not valid`)
      }
      const stateTypeRef = words[1].toUpperCase() as StatusType
      return [{'eval': `task.statusType ?? ""`}, negated, ExpOp.EQ, {'text': stateTypeRef}]
    }
    throw Error(`Could not parse condition "${conditionStr}"`)
  } catch {
    throw Error(`Could not parse condition "${conditionStr}"`)
  }
}

function normalizeTask(task: OrgmodeTask): OrgmodeTask {
  function normalizeDate(dateStr: string) {
    if (dateStr) {
      // <date> or [date] -> date
      dateStr = dateStr.replace(/[\<\[\]\>]/g, "")
      // 2021-02-03 Tue 8:20 -> 2021-02-03 8:20
      dateStr = dateStr.replace(/[a-z]/gi, " ").replace(/ +/g, " ")
    }
    return dateStr
  }
  return {
    ...task,
    deadline: normalizeDate(task.deadline),
    closed: normalizeDate(task.closed),
    scheduled: normalizeDate(task.scheduled),
  }
}

function evalCondition(
  parsedCond: Condition,
  task: OrgmodeTask,
  resolver: ConditionResolver,
): boolean {
  const [taskValue, neg, expOp, refValue] = parsedCond
  const taskValueResolved = resolver.resolve(taskValue, normalizeTask(task))
  const refValueResolved = resolver.resolve(refValue, normalizeTask(task))
  let computation = false
  if (expOp == "eq") {
    computation = taskValueResolved == refValueResolved
  } else if (expOp == "ne") {
    computation = taskValueResolved != refValueResolved
  } else if (expOp == "lt") {
    computation = taskValueResolved < refValueResolved
  } else if (expOp == "le") {
    computation = taskValueResolved <= refValueResolved
  } else if (expOp == "gt") {
    computation = taskValueResolved > refValueResolved
  } else if (expOp == "ge") {
    computation = taskValueResolved >= refValueResolved
  }
  if (neg === 'not') {
    computation = !computation
  }
  return computation
}

export class Orgzly {
  constructor(
    private settings: OrgmodePluginSettings,
    private resolver: ConditionResolver,
  ) {
    this.settings = settings
    this.resolver = resolver
  }

  public search(orgzlyExpr: string, tasks: OrgmodeTask[]): OrgmodeTask[] {
    const {ir, sort} = this.compile(orgzlyExpr)
    return this.execute(ir, sort, tasks)
  }

  public compile(orgzlyExpr: string): {ir: IntermediateRepr, sort: SortOrderChoice[]} {
    if (!orgzlyExpr) {
      return {ir: [], sort: []}
    }
    const { tree, normalizedExpr } = parseBooleanExpression(orgzlyExpr)
    const sortOrderChoice: SortOrderChoice[] = []
    const ir = this.computeExpression(tree.topNode.firstChild, normalizedExpr, sortOrderChoice)
    return {ir: ir, sort: sortOrderChoice}
  }

  private compareDate(a: OrgmodeTask, b: OrgmodeTask, prop: string, asc: boolean) {
    // We don't round to the start of the day
    // to have more precision when sorting
    const aProp = +this.resolver.resolve(
      {"evalDate": `task.${prop}`},
      normalizeTask(a)
    )
    const bProp = +this.resolver.resolve(
      {"evalDate": `task.${prop}`},
      normalizeTask(b)
    )
    if (asc) {
      return aProp - bProp
    }
    return bProp - aProp
  }

  private compareText(a: OrgmodeTask, b: OrgmodeTask, prop: string, asc: boolean, default_text: string = null) {
    let aProp = (this.resolver.resolve(
      {"eval": `task.${prop}`},
      normalizeTask(a)) ?? ""
    ).toString().toLocaleLowerCase()
    let bProp = (this.resolver.resolve(
      {"eval": `task.${prop}`},
      normalizeTask(b)) ?? ""
    ).toString().toLocaleLowerCase()
    if (default_text && !aProp) {
      aProp = default_text
    }
    if (default_text && !bProp) {
      bProp = default_text
    }
    if (asc) {
      return aProp.localeCompare(bProp)
    }
    return bProp.localeCompare(aProp)
  }

  private compareTasks(a: OrgmodeTask, b: OrgmodeTask, prop: string, asc: boolean) {
    if (['scheduled', 'deadline', 'closed'].includes(prop)) {
      return this.compareDate(a, b, prop, asc)
    } else if (['priority'].includes(prop)) {
      return this.compareText(a, b, prop, asc, this.settings.defaultPriority)
    } else if (['status'].includes(prop)) {
      return this.compareText(a, b, prop, asc)
    }
    throw Error(`Cannot compare tasks with property "${prop}"`)
  }

  private sortTasks(tasks: OrgmodeTask[], sortOrderChoice: SortOrderChoice[]): OrgmodeTask[] {
    // Orgzly documentation:
    // > Default ordering of notes is by notebook name then priority.
    // > If s or d are used in the query, they are also sorted by scheduled or deadline time.
    // > They are always sorted by position in the notebook last.
    if (!sortOrderChoice.includes("+priority") && !sortOrderChoice.includes("-priority")) {
      sortOrderChoice.push("+priority")
    }
    tasks.sort((a, b) => {
      let criteria = 0
      for (const sortOrderCriteria of sortOrderChoice) {
        const asc = sortOrderCriteria[0] === "+"
        const prop = sortOrderCriteria.slice(1)
        criteria = this.compareTasks(a, b, prop, asc)
        if (criteria !== 0) {
          return criteria
        }
      }
      return criteria
    })
    return tasks
  }

  public execute(ir: IntermediateRepr, sortOrderChoice: SortOrderChoice[], tasks: OrgmodeTask[]): OrgmodeTask[] {
    if (Array.isArray(ir) && ir.length === 0) {
      // no filtering ; all tasks
      return this.sortTasks(tasks, sortOrderChoice)
    }
    const result = []
    for (const task of tasks) {
      if (this.evalTask(ir, task)) {
        result.push(task)
      }
    }
    return this.sortTasks(result, sortOrderChoice)
  }

  private isSortOrder(node: SyntaxNode, content: string, sortOrderChoice: string[]): boolean {
    if (node.type.name === "Condition") {
      const conditionStr = content.slice(node.from, node.to)
      const condition = parseCondition(conditionStr, this.settings)
      if (!Array.isArray(condition) && "sort" in condition) {
        sortOrderChoice.push(condition["sort"][0])
        return true
      }
    }
    return false
  }

  private *iterateChildrenExcludingSortOrder(node: SyntaxNode, content: string, sortOrderChoice: string[]): Iterable<SyntaxNode> {
    if (!node.firstChild) {
      return
    }
    node = node.firstChild
    if (!this.isSortOrder(node, content, sortOrderChoice)) {
      yield node
    }
    while (node.nextSibling) {
      node = node.nextSibling
      if (!this.isSortOrder(node, content, sortOrderChoice)) {
        yield node
      }
    }
  }

  private computeExpression(node: SyntaxNode, content: string, sortOrderChoice: string[]): IntermediateRepr {
    if (!node) {
      return null
    }
    if (node.type.name === "Condition") {
      const conditionStr = content.slice(node.from, node.to)
      const condition = parseCondition(conditionStr, this.settings)
      if (!Array.isArray(condition) && "sort" in condition) {
        // only happens if there is only one order condition in the query
        // since we are filtering the children
        sortOrderChoice.push(condition["sort"][0])
        return []
      }
      return condition

    }
    const childrenExpr = [...this.iterateChildrenExcludingSortOrder(node, content, sortOrderChoice)]
      .map(node => this.computeExpression(node, content, sortOrderChoice))
    if (node.type.name === "And") {
      return {"and": childrenExpr}
    } else if (node.type.name === "Or") {
      return {"or": childrenExpr}
    }
    throw Error(`Unexpected node.type.name=${node.type.name}`)
  }

  public evalTask(ir: IntermediateRepr, task: OrgmodeTask): boolean {
    if ("and" in ir) {
      return ir["and"].reduce((acc, curr) => acc && this.evalTask(curr, task), true);
    } else if ("or" in ir) {
      return ir["or"].reduce((acc, curr) => acc || this.evalTask(curr, task), false);
    }
    if (Array.isArray(ir) && ir.length !== 0) {
      const condition = ir
      return evalCondition(condition, task, this.resolver)
    }
    throw Error(`Unexpected ir=${JSON.stringify(ir)}`)
  }
}