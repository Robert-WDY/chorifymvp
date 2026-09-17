import { readFile } from 'node:fs/promises';
const root = new URL('./methods/v1/', import.meta.url);
export async function loadAgentCatalog() {
  const manifest = JSON.parse(await readFile(new URL('index.json', root), 'utf8'));
  for (const skill of manifest.skills) if (!/^[a-z0-9-]+$/.test(skill.slug)) throw new Error('Invalid method slug');
  return { version: manifest.version, skills: manifest.skills };
}
export const projectSkills = skills => skills.map(({ slug, name, description }) => ({ slug, name, description }));
export async function readAgentSkill(catalog, slug, reference, offset = 0) {
  if (!/^[a-z0-9-]+$/.test(slug) || !catalog.skills.some(s => s.slug === slug)) throw new Error('Skill 不存在或未启用');
  const refs = JSON.parse(await readFile(new URL(`${slug}/references.json`, root), 'utf8'));
  let content;
  if (reference) {
    const ref = refs.find((r, i) => r.path === reference || `${slug}:${i}` === reference);
    if (!ref) throw new Error('参考资料不在该 Skill 清单内');
    content = ref.content ?? ref.text ?? '';
  } else content = await readFile(new URL(`${slug}/method.md`, root), 'utf8');
  return { slug, version: 'context-methods-v1', reference: reference || null, content: content.slice(offset, offset + 14000),
    nextOffset: offset + 14000 < content.length ? offset + 14000 : null,
    references: refs.map(r => r.path), resources: refs.map((r, i) => ({ id: `${slug}:${i}`, path: r.path })) };
}
