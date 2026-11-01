// Checks a message payload against Discord's documented Components V2 rules, so tests fail
// on layouts Discord would reject with a 400.

const COMPONENTS_V2 = 1 << 15;
const EPHEMERAL = 1 << 6;

function validateButton(button, errors, customIds) {
  if (button.type !== 2) {
    errors.push(`action row child must be a button, got ${button.type}`);
    return;
  }
  // Premium (buy) buttons: Discord draws the label and price from the SKU.
  if (button.style === 6) {
    if (!/^\w+$/.test(button.sku_id || "")) errors.push("premium button needs a sku_id");
    for (const field of ["custom_id", "label", "emoji", "url"]) {
      if (button[field] !== undefined) errors.push(`premium button cannot have ${field}`);
    }
    return;
  }
  if (button.sku_id !== undefined) errors.push("only premium buttons can have a sku_id");
  if (!button.label && !button.emoji) errors.push("button needs a label or emoji");
  if (button.label && button.label.length > 80) errors.push("button label over 80 characters");
  if (button.style === 5) {
    if (!/^https?:\/\//.test(button.url || "")) errors.push("link button needs an http(s) url");
    if (button.custom_id) errors.push("link button cannot have a custom_id");
  } else {
    if (!button.custom_id || button.custom_id.length > 100) errors.push("button custom_id must be 1-100 characters");
    if (customIds.has(button.custom_id)) errors.push(`duplicate custom_id ${button.custom_id}`);
    customIds.add(button.custom_id);
  }
}

export function validateMessage(payload, { edit = false } = {}) {
  const errors = [];
  const flags = Number(payload?.flags || 0);

  if (edit && flags & EPHEMERAL) errors.push("edits cannot set the EPHEMERAL flag");

  if (!(flags & COMPONENTS_V2)) {
    if (!payload?.content && !payload?.embeds?.length && !payload?.components?.length) errors.push("empty message");
    return errors;
  }

  if (payload.content) errors.push("content is not allowed with IS_COMPONENTS_V2");
  if (payload.embeds?.length) errors.push("embeds are not allowed with IS_COMPONENTS_V2");
  if (!Array.isArray(payload.components) || payload.components.length === 0) errors.push("components required");

  let count = 0;
  let characters = 0;
  const customIds = new Set();

  const walk = (components, parent) => {
    for (const component of components || []) {
      count += 1;
      switch (component.type) {
        case 17:
          if (parent) errors.push("containers must be top level");
          if (!component.components?.length) errors.push("empty container");
          if (component.accent_color !== undefined && (component.accent_color < 0 || component.accent_color > 0xffffff)) {
            errors.push("accent_color out of range");
          }
          walk(component.components, 17);
          break;
        case 9:
          if (!component.accessory) errors.push("section requires an accessory");
          if (!(component.components?.length >= 1 && component.components.length <= 3)) errors.push("section needs 1-3 text displays");
          for (const child of component.components || []) if (child.type !== 10) errors.push("section children must be text displays");
          walk(component.components, 9);
          count += 1;
          if (component.accessory?.type === 11) {
            if (!/^https?:\/\//.test(component.accessory.media?.url || "")) errors.push("thumbnail needs an http(s) url");
          } else if (component.accessory?.type === 2) {
            validateButton(component.accessory, errors, customIds);
          } else {
            errors.push("section accessory must be a thumbnail or button");
          }
          break;
        case 10:
          if (typeof component.content !== "string" || component.content.length === 0) errors.push("text display needs content");
          characters += String(component.content || "").length;
          break;
        case 12:
          if (!(component.items?.length >= 1 && component.items.length <= 10)) errors.push("media gallery needs 1-10 items");
          for (const item of component.items || []) if (!/^https?:\/\//.test(item.media?.url || "")) errors.push("gallery item needs a url");
          break;
        case 14:
          if (component.spacing !== undefined && ![1, 2].includes(component.spacing)) errors.push("separator spacing must be 1 or 2");
          break;
        case 1:
          if (!(component.components?.length >= 1 && component.components.length <= 5)) errors.push("action row needs 1-5 buttons");
          for (const child of component.components || []) {
            count += 1;
            validateButton(child, errors, customIds);
          }
          break;
        default:
          errors.push(`unexpected component type ${component.type}`);
      }
    }
  };

  walk(payload.components, null);
  if (count > 40) errors.push(`too many components (${count} > 40)`);
  if (characters > 4000) errors.push(`too much text (${characters} > 4000)`);
  return errors;
}

export function allText(payload) {
  const parts = [];
  const walk = (components = []) => {
    for (const component of components) {
      if (component.type === 10) parts.push(component.content);
      if (component.components) walk(component.components);
    }
  };
  walk(payload?.components);
  return parts.join("\n");
}

export function findButtons(payload) {
  const buttons = [];
  const walk = (components = []) => {
    for (const component of components) {
      if (component.type === 2) buttons.push(component);
      if (component.components) walk(component.components);
      if (component.accessory?.type === 2) buttons.push(component.accessory);
    }
  };
  walk(payload?.components);
  return buttons;
}

export function countImages(payload) {
  let images = 0;
  const walk = (components = []) => {
    for (const component of components) {
      if (component.type === 12) images += component.items.length;
      if (component.accessory?.type === 11) images += 1;
      if (component.components) walk(component.components);
    }
  };
  walk(payload?.components);
  return images;
}
