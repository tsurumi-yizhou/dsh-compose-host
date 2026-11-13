// Derived from @deepseek-ai/dsh-agent-default-model 0.2.2-rc.1 (MIT; see LICENSE).
// The compose profile's `agentDefaultModel`: the upstream service plus a
// `rememberLastSelection` switch, so a fixed default survives Session model
// changes. Replaces the base row by id; no DSH source is patched.
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

const FIXED = { status: "skipped", code: "settings/fixed-default" };
const SKIPPED = Symbol("fixed-default");

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings) {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort },
  };
}

export class DefaultModelService extends Service {
  ownerContext;
  config;
  saves = Promise.resolve();
  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
    rememberLastSelection: z.boolean().default(true).volatile(),
  });

  constructor(ownerContext, config) {
    super(ownerContext, "agentDefaultModel");
    this.ownerContext = ownerContext;
    this.config = config;
    ownerContext.inject(["settings"], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber));
    });
  }

  /** @returns a detached provider, model, and optional reasoning selection. */
  currentSelection() {
    const reasoningEffort = this.config.reasoningEffort.get();
    return selection({
      provider: this.config.provider.get(),
      model: this.config.model.get(),
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    });
  }

  /** Whether Session selections should become the next conversation's default. */
  remembersLastSelection() {
    return this.config.rememberLastSelection.get() !== false;
  }

  /**
   * Save an automatic default in submission order without overwriting fixed mode.
   * The raw mode is rechecked under ConfigEditor's profile lock, not just when queued.
   * A deployment without a configuration editor keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns a persistence receipt; upstream callers ignore it.
   */
  async saveSelection(next) {
    if (!this.remembersLastSelection()) return FIXED;
    const saved = this.saves.then(async () => {
      if (!this.remembersLastSelection()) return FIXED;
      const entry = this.ownerContext.fiber.entry;
      const editor = this.ctx.get("configEditor");
      if (entry === undefined || editor === undefined) return undefined;
      try {
        await editor.edit(entry, (current) => {
          if (current.rememberLastSelection === false) throw SKIPPED;
          const config = { ...current, provider: next.provider, model: next.model };
          if (next.reasoningEffort === undefined) delete config.reasoningEffort;
          else config.reasoningEffort = String(next.reasoningEffort);
          return config;
        });
      } catch (error) {
        if (error === SKIPPED) return FIXED;
        throw error;
      }
      return { status: "saved" };
    });
    this.saves = saved.catch(() => {});
    return await saved;
  }
}

export default DefaultModelService;
