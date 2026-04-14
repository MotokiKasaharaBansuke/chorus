import { Show } from "solid-js";
import { useTabStore } from "../../stores/tab-store";
import { ResizableSplit } from "./resizable-split";
import { PaneGroup } from "./pane-group";
import type { LayoutNode, SplitNode, PaneGroupNode, Tab, LayoutEdges } from "../../types";
import { ALL_EDGES } from "../../types";

interface LayoutRendererProps {
  nodeOverride?: LayoutNode;
  edges?: LayoutEdges;
  onCloseTab: (tabId: string) => void;
  onRestartTab: (tab: Tab) => void;
}

function isSplitNode(node: LayoutNode): node is SplitNode {
  return node.type === "split";
}

function isPaneGroupNode(node: LayoutNode): node is PaneGroupNode {
  return node.type === "pane-group";
}

export function LayoutRenderer(props: LayoutRendererProps) {
  const store = useTabStore();
  const edges = () => props.edges ?? ALL_EDGES;
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
        {(split) => {
          const isH = () => split().direction === "horizontal";
          const firstEdges = (): LayoutEdges => {
            const e = edges();
            return isH() ? { ...e, right: false } : { ...e, bottom: false };
          };
          const secondEdges = (): LayoutEdges => {
            const e = edges();
            return isH() ? { ...e, left: false } : { ...e, top: false };
          };
          return (
            <ResizableSplit
              direction={split().direction}
              ratio={split().ratio}
              first={
                <LayoutRenderer
                  nodeOverride={split().children[0]}
                  edges={firstEdges()}
                  onCloseTab={props.onCloseTab}
                  onRestartTab={props.onRestartTab}
                />
              }
              second={
                <LayoutRenderer
                  nodeOverride={split().children[1]}
                  edges={secondEdges()}
                  onCloseTab={props.onCloseTab}
                  onRestartTab={props.onRestartTab}
                />
              }
              onRatioChange={(ratio) => store.updateSplitRatio(split().id, ratio)}
            />
          );
        }}
      </Show>
      <Show when={paneGroupNode()}>
        {(group) => (
          <PaneGroup
            node={group()}
            edges={edges()}
            onCloseTab={props.onCloseTab}
            onRestartTab={props.onRestartTab}
          />
        )}
      </Show>
    </>
  );
}
