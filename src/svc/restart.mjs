// Sends a reviewed step back to the studio after the owner's decision on one piece (a style frame, a still): in review it goes back
// as "changes" with the words, approved it is reopened. The runner then makes the next round or the remake itself.
import { loadProject, projectPipeline } from '../projects.mjs';
import { stepView, respond, reopen } from '../gates.mjs';

export function restartStep(root, id, stepKey, text) {
  const pipeline = projectPipeline(root, id);
  const step = stepView(loadProject(root, id), pipeline).find((s) => s.key === stepKey);
  if (!step) return null;
  if (step.state === 'in_review') return respond(root, id, stepKey, step.version, { verdict: 'changes', overall: text });
  if (['approved', 'done'].includes(step.state)) return reopen(root, id, stepKey, { overall: text });
  return null;
}
