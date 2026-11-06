import { describe, expect, it } from 'vitest';
import schema from '../src/screens/new-project/schema.fallback.json';
import { TEMPLATES } from '../src/screens/new-project/templates';

interface SchemaChoice {
  value: string | number;
}
interface SchemaField {
  id: string;
  choices?: SchemaChoice[];
}

const fields = new Map<string, SchemaField>(
  schema.sections.flatMap((section) => (section.fields as SchemaField[]).map((f) => [f.id, f] as const)),
);

const settingsOf = (brief: Record<string, unknown>): [string, unknown][] =>
  Object.entries(brief).flatMap(([section, keys]) =>
    Object.entries(keys as Record<string, unknown>).map(([key, value]): [string, unknown] => [
      `${section}.${key}`,
      value,
    ]),
  );

describe('new project templates', () => {
  it('has a name each, all marked as templates', () => {
    const names = TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(TEMPLATES.every((t) => t.template)).toBe(true);
  });
  it('never touch the idea, the name, the sources or the meta', () => {
    for (const template of TEMPLATES) {
      expect(Object.keys(template.brief)).not.toContain('idea');
      expect(Object.keys(template.brief)).not.toContain('title');
      expect(Object.keys(template.brief)).not.toContain('sources');
      expect(Object.keys(template.brief)).not.toContain('meta');
    }
  });
  it('set only settings the form has, to choices it offers', () => {
    for (const template of TEMPLATES) {
      for (const [path, value] of settingsOf(template.brief)) {
        const field = fields.get(path);
        expect(field, `${template.name}: ${path}`).toBeDefined();
        if (field?.choices && typeof value === 'string') {
          expect(
            field.choices.map((c) => c.value),
            `${template.name}: ${path}`,
          ).toContain(value);
        }
      }
    }
  });
});
