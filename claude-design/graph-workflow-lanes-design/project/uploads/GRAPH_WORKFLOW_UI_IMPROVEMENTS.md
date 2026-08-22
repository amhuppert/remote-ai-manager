# Graph Workflow Builder & Execution UI

The Graph Worfklow builder and execution pages UI need an overhaul.

Many extensions to the Graph Workflow behavior have landed since the UI was first designed.
We need to rethink the design now, so that the pages are holistically designed and look like they were specifically designed with the current functionality in mind (rather than UI updates for each extension being tacked on, like they were).


## Problems

- Validator results are duplicated (same messages) in the right panel multiple times.
- Cannot view transcripts of previous iterations (only the latest)
- Right panel needs to be collapsible
- Right panel config is noisy - need design to make it easier to find/read information and hide items I'm most likely not interested in by default
- Visualization of lane placement
- Executions history panel is not collapsible.
- Pages are unusable on mobile

### Graph Node UI Problems

- Rework design to show more information at a glance (graph workflows have a lot more functionality than when originally designed). Need to be able to see the most important configurations for each context without having to click in to the config panel for each context.
