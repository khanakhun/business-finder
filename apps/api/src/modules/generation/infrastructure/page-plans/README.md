# Page plans (BF-040)

One YAML file per template. `match` lists taxonomy path prefixes; the most specific match wins, `default` catches
the rest. A page or block `requires` display facts (`kinds`, at least `min`) or image candidates (`images`); a page
without them collapses into `collapseInto` (default home), taking its `section: true` blocks and its `fallback`;
a block without them is left out (or uses its `otherwise` variant). Never filler.
