// Checks slash-command definitions against Discord's documented registration rules, so tests
// fail on definitions Discord would reject (a rejected bulk update changes nothing).

const NAME = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const STRING = 3;
const INTEGER = 4;
const NUMBER = 10;
const VALID_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

function checkName(value, where, errors) {
  if (typeof value !== "string" || !NAME.test(value) || value !== value.toLowerCase()) {
    errors.push(`${where}: name "${value}" must be 1-32 lowercase letters, numbers, - or _`);
  }
}

function checkDescription(value, where, errors) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) errors.push(`${where}: description must be 1-100 characters`);
}

function characterCount(command) {
  let total = command.name.length + command.description.length;
  const walk = (options = []) => {
    for (const option of options) {
      total += option.name.length + option.description.length;
      for (const choice of option.choices || []) total += choice.name.length + String(choice.value).length;
      walk(option.options);
    }
  };
  walk(command.options);
  return total;
}

function checkOptions(options, where, errors, depth) {
  if (!options) return;
  if (!Array.isArray(options)) {
    errors.push(`${where}: options must be an array`);
    return;
  }
  if (options.length > 25) errors.push(`${where}: more than 25 options`);

  const names = new Set();
  const nested = options.filter((o) => o.type === SUB_COMMAND || o.type === SUB_COMMAND_GROUP).length;
  if (nested > 0 && nested !== options.length) errors.push(`${where}: subcommands can't be mixed with other options`);

  let seenOptional = false;
  for (const option of options) {
    const at = `${where} > ${option.name}`;
    checkName(option.name, at, errors);
    checkDescription(option.description, at, errors);
    if (names.has(option.name)) errors.push(`${at}: duplicate option name`);
    names.add(option.name);
    if (!VALID_TYPES.has(option.type)) errors.push(`${at}: unknown option type ${option.type}`);

    if (option.type === SUB_COMMAND_GROUP) {
      if (depth > 0) errors.push(`${at}: groups can only sit at the top level`);
      if (!option.options?.length || option.options.some((o) => o.type !== SUB_COMMAND)) errors.push(`${at}: a group must hold only subcommands`);
      checkOptions(option.options, at, errors, depth + 1);
      continue;
    }
    if (option.type === SUB_COMMAND) {
      if (depth > 1) errors.push(`${at}: subcommands nest at most one group deep`);
      if (option.options?.some((o) => o.type === SUB_COMMAND || o.type === SUB_COMMAND_GROUP)) errors.push(`${at}: subcommands can't contain subcommands`);
      checkOptions(option.options, at, errors, depth + 1);
      continue;
    }

    if (option.required) {
      if (seenOptional) errors.push(`${at}: required options must come before optional ones`);
    } else {
      seenOptional = true;
    }
    if (option.choices) {
      if (option.autocomplete) errors.push(`${at}: autocomplete can't be combined with choices`);
      if (option.choices.length > 25) errors.push(`${at}: more than 25 choices`);
      for (const choice of option.choices) {
        if (!choice.name || choice.name.length > 100) errors.push(`${at}: choice name must be 1-100 characters`);
        const numeric = option.type === INTEGER || option.type === NUMBER;
        if (numeric ? typeof choice.value !== "number" : typeof choice.value !== "string") errors.push(`${at}: choice value has the wrong type`);
        if (option.type === INTEGER && !Number.isInteger(choice.value)) errors.push(`${at}: integer choice must be whole`);
      }
    }
    if (option.autocomplete && ![STRING, INTEGER, NUMBER].includes(option.type)) errors.push(`${at}: autocomplete needs a string or number option`);
    if ("min_length" in option || "max_length" in option) {
      if (option.type !== STRING) errors.push(`${at}: min/max_length only apply to strings`);
      const min = option.min_length ?? 0;
      const max = option.max_length ?? 6000;
      if (min < 0 || max < 1 || max > 6000 || min > max) errors.push(`${at}: bad length limits`);
    }
    if ("min_value" in option || "max_value" in option) {
      if (![INTEGER, NUMBER].includes(option.type)) errors.push(`${at}: min/max_value only apply to numbers`);
      if ((option.min_value ?? -Infinity) > (option.max_value ?? Infinity)) errors.push(`${at}: min_value above max_value`);
    }
  }
}

export function validateCommands(commands, { scope = "global" } = {}) {
  const errors = [];
  if (!Array.isArray(commands)) return ["commands must be an array"];
  if (commands.length > 100) errors.push(`${scope}: more than 100 slash commands`);
  const names = new Set();
  for (const command of commands) {
    const where = `/${command.name}`;
    checkName(command.name, where, errors);
    checkDescription(command.description, where, errors);
    if (names.has(command.name)) errors.push(`${where}: registered twice`);
    names.add(command.name);
    if (command.type !== undefined && command.type !== 1) errors.push(`${where}: expected a slash command (type 1)`);
    if (command.default_member_permissions !== undefined && command.default_member_permissions !== null && !/^\d+$/.test(command.default_member_permissions)) {
      errors.push(`${where}: default_member_permissions must be a string of digits`);
    }
    checkOptions(command.options, where, errors, 0);
    if (characterCount(command) > 4000) errors.push(`${where}: over 4000 characters in total`);
  }
  return errors;
}
