import z from '@deepseek-ai/schemastery';
import { createResearchClient } from './client.mjs';

export const name = 'compose-research';
export const inject = ['credentials'];
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
  search: z.boolean().default(true).volatile(),
  readLinks: z.boolean().default(true).volatile(),
  deepResearch: z.boolean().default(true).volatile(),
  documents: z.boolean().default(true).volatile(),
  ocr: z.boolean().default(true).volatile(),
});

export function apply(ctx, config) {
  ctx.provide('composeResearch', {
    enabled: capability => config[capability].get(),
    async client() {
      const key = (await ctx.credentials.resolve(config.apiKeyEnv.get()))?.value;
      if (!key?.trim()) throw new Error('Configure a DeepSeek API key in File understanding & web research settings.');
      return createResearchClient(key);
    },
  });
}
