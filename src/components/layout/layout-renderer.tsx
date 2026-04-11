import { Show } from "solid-js";
import { useTabStore } from "../../stores/tab-store";
import { ResizableSplit } from "./resizable-split";
import { PaneGroup } from "./pane-group";
import type { LayoutNode, SplitNode, PaneGroupNode, Tab } from "../../types";

interface LayoutRendererProps {
  /** If provided, render this node. Otherwise read root from store. */
  nodeOverride?: LayoutNode;
  onCloseTab: (tabId: string) => void;
  onRestartTab: (tab: Tab) => void;
}

/** Type guard: discriminated union narrowing without `as` */
function isSplitNode(node: LayoutNode): node is SplitNode {
  return node.type === "split";
}

function isPaneGroupNode(node: LayoutNode): node is PaneGroupNode {
  return node.type === "pane-group";
}

export function LayoutRenderer(props: LayoutRendererProps) {
  const store = useTabStore();

  const node = () => props.nodeOverride ?? store.layout;

  const splitNode = (): SplitNode | null => {
    const n = node();
    return n && isSplitNode(n) ? n : null;
  };

  const paneGroupNode = (): PaneGroupNode | null => {
    const n = node();
    return n && isPaneGroupNode(n) ? n : null;
  };

  return (
    <>
      <Show when={splitNode()}>
        {(split) => (
          <ResizableSplit
            direction={split().direction}
            ratio={split().ratio}
            first={
              <LayoutRenderer
                nodeOverride={split().children[0]}
                onCloseTab={props.onCloseTab}
                onRestartTab={props.onRestartTab}
              />
            }
            second={
              <LayoutRenderer
                nodeOverride={split().children[1]}
                onCloseTab={props.onCloseTab}
                onRestartTab={props.onRestartTab}
              />
            }
            onRatioChange={(ratio) => store.updateSplitRatio(split().id, ratio)}
          />
        )}
      </Show>
      <Show when={paneGroupNode()}>
        {(group) => (
          <PaneGroup
            node={group()}
            onCloseTab={props.onCloseTab}
            onRestartTab={props.onRestartTab}
          />
        )}
      </Show>
    </>
  );
}
