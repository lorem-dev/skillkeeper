//! The skill dependency graph.
//!
//! A skill declares the other skills of its own repository that it needs
//! (`skillkeeper.requires`, see [`crate::skills::manifest`]). This module is the
//! only place that graph is traversed: transitive closure for install and
//! update, reverse closure for "what breaks if this goes away", plus the two
//! repository-level faults -- a reference to a skill that does not exist, and a
//! cycle.
//!
//! Pure: no ports, no I/O. Every traversal is deterministic, because its output
//! order is what the CLI prints and what the desktop review table lists.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::models::ResolvedSkill;
use crate::skills::group_path::skill_path;

/// Forward and reverse adjacency over skill paths.
///
/// A path present as a key of `forward` is a skill of this repository; a path
/// that only ever appears as a value is a missing reference. Both maps are
/// ordered, so every traversal below is reproducible.
#[derive(Debug, Clone, Default)]
pub struct RequiresGraph {
    forward: BTreeMap<String, Vec<String>>,
    reverse: BTreeMap<String, Vec<String>>,
}

impl RequiresGraph {
    /// Build from a resolved skill list. A skill with no `requires` contributes
    /// an empty edge list -- it is still a node, which is what makes
    /// [`Self::contains`] able to tell "no dependencies" from "not a skill".
    pub fn build(skills: &[ResolvedSkill]) -> Self {
        Self::build_from_edges(skills.iter().map(|s| {
            (
                skill_path(s.id.group.as_deref(), &s.id.name),
                s.manifest.requires.clone().unwrap_or_default(),
            )
        }))
    }

    /// Build from raw `(path, requires)` pairs. Used by [`Self::build`] and by
    /// callers that already hold edges rather than resolved skills.
    pub fn build_from_edges(edges: impl IntoIterator<Item = (String, Vec<String>)>) -> Self {
        let mut forward: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut reverse: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (from, to) in edges {
            for target in &to {
                let back = reverse.entry(target.clone()).or_default();
                if !back.contains(&from) {
                    back.push(from.clone());
                }
            }
            // A repeated key merges rather than replaces: two repositories are
            // never mixed here, but a caller building from several sources
            // should not silently lose edges.
            let entry = forward.entry(from).or_default();
            for target in to {
                if !entry.contains(&target) {
                    entry.push(target);
                }
            }
        }
        for list in reverse.values_mut() {
            list.sort();
        }
        Self { forward, reverse }
    }

    /// Whether `path` is a skill of this graph (as opposed to a reference to
    /// something absent).
    pub fn contains(&self, path: &str) -> bool {
        self.forward.contains_key(path)
    }

    /// The dependencies `path` declares, in the author's order. Empty when the
    /// skill declares none, and also when `path` is not a skill at all.
    pub fn requires_of(&self, path: &str) -> &[String] {
        self.forward.get(path).map_or(&[], Vec::as_slice)
    }

    /// Transitive closure of `roots`, roots included, each root's subtree
    /// walked breadth first before the next root starts.
    ///
    /// Each root's own subtree is fully drained, in breadth-first order,
    /// before the next root starts -- a shared `seen` set means a root
    /// reached earlier (directly or as someone else's dependency) does not
    /// restart its subtree, but the roots themselves are never interleaved.
    /// That is what keeps `closure(&[a, x])` equal to the concatenation of
    /// `closure(&[a])` and the still-unseen part of `closure(&[x])`, which is
    /// the property callers rely on when they report installs root by root.
    ///
    /// The order of `roots` therefore matters whenever two roots' subtrees
    /// overlap: `closure(&[a, x])` and `closure(&[x, a])` can list the shared
    /// nodes at different positions, because whichever root is processed
    /// first claims them first. Both orders are individually deterministic --
    /// the same input always yields the same output -- but the two orders are
    /// not interchangeable with each other.
    ///
    /// Missing references are included: the caller wants to know they were
    /// reached (to report them), and excluding them here would make a broken
    /// dependency indistinguishable from an absent one. Cycle-safe -- a visited
    /// node is never queued twice.
    pub fn closure(&self, roots: &[String]) -> Vec<String> {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut out: Vec<String> = Vec::new();
        for root in roots {
            if !seen.insert(root.as_str()) {
                continue;
            }
            let mut queue: VecDeque<&str> = VecDeque::new();
            queue.push_back(root.as_str());
            out.push(root.clone());
            while let Some(current) = queue.pop_front() {
                for target in self.requires_of(current) {
                    if seen.insert(target.as_str()) {
                        queue.push_back(target.as_str());
                        out.push(target.clone());
                    }
                }
            }
        }
        out
    }

    /// Everything that depends on any of `targets`, directly or transitively.
    /// The targets themselves are NOT included -- the question this answers is
    /// "what else breaks", and including the cause would make the caller filter
    /// it back out at every call site.
    pub fn dependents(&self, targets: &[String]) -> Vec<String> {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut queue: VecDeque<&str> = VecDeque::new();
        for target in targets {
            seen.insert(target.as_str());
            queue.push_back(target.as_str());
        }
        let mut out: BTreeSet<String> = BTreeSet::new();
        while let Some(current) = queue.pop_front() {
            let Some(back) = self.reverse.get(current) else {
                continue;
            };
            for dependent in back {
                if seen.insert(dependent.as_str()) {
                    queue.push_back(dependent.as_str());
                    out.insert(dependent.clone());
                }
            }
        }
        // Sorted rather than traversal-ordered: this list is a report, and a
        // report reads better alphabetically than by discovery order.
        out.into_iter().collect()
    }

    /// Every `(referrer, missing reference)` pair, sorted by referrer then
    /// reference.
    pub fn missing(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (from, targets) in &self.forward {
            for target in targets {
                if !self.forward.contains_key(target) {
                    out.push((from.clone(), target.clone()));
                }
            }
        }
        out.sort();
        out
    }

    /// Skills that require themselves, sorted.
    ///
    /// A self edge is a cycle of length one, and [`Self::cycles`] does not
    /// report it -- see the note there. Reported separately so a caller can
    /// name the one skill involved instead of printing a members list of one.
    ///
    /// This is not an unreachable defensive case. The manifest parser rejects a
    /// self reference, but it only ever sees the frontmatter, and a skill's
    /// group comes from the directory layout instead. So the reference `"g/a"`
    /// inside `g/a` -- the absolute spelling every reference must use -- is not
    /// a self reference as far as the parser can tell, and reaches this graph
    /// as a genuine self edge.
    pub fn self_edges(&self) -> Vec<String> {
        self.forward
            .iter()
            .filter(|&(from, targets)| targets.contains(from))
            .map(|(from, _)| from.clone())
            .collect()
    }

    /// Strongly connected components of more than one node, each sorted, the
    /// outer list sorted.
    ///
    /// A node that references itself is NOT reported here: it forms a one-node
    /// strongly connected component, which the `component.len() > 1` filter
    /// below discards. That is deliberate, and [`Self::self_edges`] is where
    /// such a skill is reported instead -- naming one skill reads better than a
    /// members list of one.
    ///
    /// Iterative Tarjan, so a pathological repository cannot blow the stack.
    pub fn cycles(&self) -> Vec<Vec<String>> {
        let nodes: Vec<&str> = self.forward.keys().map(String::as_str).collect();
        let index_of: BTreeMap<&str, usize> =
            nodes.iter().enumerate().map(|(i, n)| (*n, i)).collect();
        let count = nodes.len();

        let mut index = vec![usize::MAX; count];
        let mut low = vec![0usize; count];
        let mut on_stack = vec![false; count];
        let mut stack: Vec<usize> = Vec::new();
        let mut next_index = 0usize;
        let mut components: Vec<Vec<String>> = Vec::new();

        // (node, position in that node's edge list)
        let mut call: Vec<(usize, usize)> = Vec::new();

        for start in 0..count {
            if index[start] != usize::MAX {
                continue;
            }
            call.push((start, 0));
            index[start] = next_index;
            low[start] = next_index;
            next_index += 1;
            stack.push(start);
            on_stack[start] = true;

            while let Some((node, edge)) = call.pop() {
                let edges = self.requires_of(nodes[node]);
                if edge < edges.len() {
                    call.push((node, edge + 1));
                    // A missing reference is not a node, so it cannot be part of
                    // a cycle; skip it here and let `missing` report it.
                    let Some(&next) = index_of.get(edges[edge].as_str()) else {
                        continue;
                    };
                    if index[next] == usize::MAX {
                        index[next] = next_index;
                        low[next] = next_index;
                        next_index += 1;
                        stack.push(next);
                        on_stack[next] = true;
                        call.push((next, 0));
                    } else if on_stack[next] {
                        low[node] = low[node].min(index[next]);
                    }
                    continue;
                }
                // Finished this node: fold its low link into its parent, then
                // close a component if this node is a root.
                if let Some(&(parent, _)) = call.last() {
                    low[parent] = low[parent].min(low[node]);
                }
                if low[node] == index[node] {
                    let mut component: Vec<String> = Vec::new();
                    while let Some(member) = stack.pop() {
                        on_stack[member] = false;
                        component.push(nodes[member].to_string());
                        if member == node {
                            break;
                        }
                    }
                    if component.len() > 1 {
                        component.sort();
                        components.push(component);
                    }
                }
            }
        }
        components.sort();
        components
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A graph from `(path, requires)` pairs. Every path listed as a key is a
    /// skill of the repository; anything referenced but not keyed is missing.
    fn graph(edges: &[(&str, &[&str])]) -> RequiresGraph {
        RequiresGraph::build_from_edges(edges.iter().map(|(from, to)| {
            (
                (*from).to_string(),
                to.iter().map(|t| (*t).to_string()).collect::<Vec<String>>(),
            )
        }))
    }

    fn chain() -> RequiresGraph {
        graph(&[("a", &["b"]), ("b", &["c"]), ("c", &[])])
    }

    fn diamond() -> RequiresGraph {
        graph(&[("a", &["b", "c"]), ("b", &["d"]), ("c", &["d"]), ("d", &[])])
    }

    #[test]
    fn closure_of_a_chain_includes_every_hop_and_the_root() {
        assert_eq!(chain().closure(&["a".to_string()]), vec!["a", "b", "c"]);
    }

    #[test]
    fn closure_of_a_leaf_is_just_the_leaf() {
        assert_eq!(chain().closure(&["c".to_string()]), vec!["c"]);
    }

    #[test]
    fn closure_of_a_diamond_lists_the_shared_dependency_once() {
        assert_eq!(
            diamond().closure(&["a".to_string()]),
            vec!["a", "b", "c", "d"]
        );
    }

    #[test]
    fn closure_of_several_roots_is_their_union() {
        let g = graph(&[("a", &["b"]), ("b", &[]), ("x", &["y"]), ("y", &[])]);
        assert_eq!(
            g.closure(&["a".to_string(), "x".to_string()]),
            vec!["a", "b", "x", "y"]
        );
    }

    #[test]
    fn closure_of_overlapping_roots_follows_root_order_not_a_sorted_union() {
        // "b" is reachable from "a", so when both are roots the shared
        // subtree is only ever claimed by whichever root is processed
        // first. This is a mirror-divergence hazard: a naive multi-root BFS
        // (or a sorted union of independent closures) would give the same
        // answer regardless of root order, but this implementation does
        // not, and that is intentional -- see the doc on `closure`.
        let g = graph(&[("a", &["b"]), ("b", &["c"]), ("c", &[])]);
        assert_eq!(
            g.closure(&["a".to_string(), "b".to_string()]),
            vec!["a", "b", "c"]
        );
        assert_eq!(
            g.closure(&["b".to_string(), "a".to_string()]),
            vec!["b", "c", "a"]
        );
    }

    #[test]
    fn closure_terminates_on_a_cycle() {
        let g = graph(&[("a", &["b"]), ("b", &["a"])]);
        assert_eq!(g.closure(&["a".to_string()]), vec!["a", "b"]);
    }

    #[test]
    fn closure_includes_a_missing_target_so_the_caller_can_report_it() {
        let g = graph(&[("a", &["ghost"])]);
        assert_eq!(g.closure(&["a".to_string()]), vec!["a", "ghost"]);
    }

    #[test]
    fn closure_of_an_unknown_root_is_that_root_alone() {
        assert_eq!(chain().closure(&["nope".to_string()]), vec!["nope"]);
    }

    #[test]
    fn closure_is_breadth_first_and_deterministic() {
        let g = diamond();
        assert_eq!(g.closure(&["a".to_string()]), g.closure(&["a".to_string()]));
        // Breadth first: both direct dependencies precede the shared one.
        assert_eq!(g.closure(&["a".to_string()]), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn dependents_walks_the_edges_backwards_and_excludes_the_target() {
        assert_eq!(chain().dependents(&["c".to_string()]), vec!["a", "b"]);
        assert_eq!(
            diamond().dependents(&["d".to_string()]),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn dependents_of_a_root_is_empty() {
        assert!(chain().dependents(&["a".to_string()]).is_empty());
    }

    #[test]
    fn dependents_terminates_on_a_cycle() {
        let g = graph(&[("a", &["b"]), ("b", &["a"])]);
        assert_eq!(g.dependents(&["a".to_string()]), vec!["b"]);
    }

    #[test]
    fn missing_names_the_referrer_and_the_absent_reference() {
        let g = graph(&[("a", &["ghost", "b"]), ("b", &["also-gone"])]);
        assert_eq!(
            g.missing(),
            vec![
                ("a".to_string(), "ghost".to_string()),
                ("b".to_string(), "also-gone".to_string()),
            ]
        );
    }

    #[test]
    fn missing_is_empty_for_a_whole_graph() {
        assert!(chain().missing().is_empty());
        assert!(diamond().missing().is_empty());
    }

    #[test]
    fn cycles_reports_each_component_once_sorted() {
        let g = graph(&[("a", &["b"]), ("b", &["a"]), ("x", &["y"]), ("y", &[])]);
        assert_eq!(g.cycles(), vec![vec!["a".to_string(), "b".to_string()]]);
    }

    #[test]
    fn cycles_reports_a_three_node_cycle() {
        let g = graph(&[("a", &["b"]), ("b", &["c"]), ("c", &["a"])]);
        assert_eq!(
            g.cycles(),
            vec![vec!["a".to_string(), "b".to_string(), "c".to_string()]]
        );
    }

    #[test]
    fn cycles_is_empty_for_a_dag() {
        assert!(diamond().cycles().is_empty());
    }

    #[test]
    fn self_edges_reports_what_cycles_discards() {
        // The division of labour: a one-node component is not a `cycles()`
        // result, and a genuine component is not a `self_edges()` one.
        let g = graph(&[("g/a", &["g/a"]), ("x", &["y"]), ("y", &["x"])]);
        assert_eq!(g.self_edges(), vec!["g/a".to_string()]);
        assert_eq!(g.cycles(), vec![vec!["x".to_string(), "y".to_string()]]);
        // And a self reference is not a missing one: the target is a skill.
        assert!(g.missing().is_empty());
    }

    #[test]
    fn self_edges_is_empty_for_a_dag() {
        assert!(diamond().self_edges().is_empty());
    }

    #[test]
    fn a_skill_declaring_an_empty_list_has_no_dependencies() {
        let g = graph(&[("a", &[])]);
        assert!(g.requires_of("a").is_empty());
        assert!(g.contains("a"));
        assert!(!g.contains("ghost"));
    }

    #[test]
    fn cycles_reports_two_independent_cycles_in_one_graph() {
        // A regression guard for the iterative Tarjan implementation: two
        // disjoint strongly connected components in the same graph, plus a
        // DAG edge between them, must both be reported and neither merged
        // with the other nor with the acyclic tail.
        let g = graph(&[
            ("a", &["b"]),
            ("b", &["a"]),
            ("x", &["y"]),
            ("y", &["z"]),
            ("z", &["x"]),
            ("z", &["tail"]),
            ("tail", &[]),
        ]);
        assert_eq!(
            g.cycles(),
            vec![
                vec!["a".to_string(), "b".to_string()],
                vec!["x".to_string(), "y".to_string(), "z".to_string()],
            ]
        );
    }
}
