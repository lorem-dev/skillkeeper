/**
 * The onboarding tour's skills/agents steps illustrate the real `TreeView`
 * with a small fixture tree instead of live store data. `demoTree` names the
 * three fixture shapes; the tree itself is built in `features/onboardingDemo`
 * (a `features` module, so it may import `entities/project` and
 * `entities/agent` -- `systems/onboarding` may not) and injected into
 * `OnboardingOverlay` from `app/App.tsx` via a render prop, the same pattern
 * used for `aboutIdentity`/`aboutFooter`.
 */
export type DemoTreeVariant = 'skills-installed' | 'skills-actions' | 'agents';
