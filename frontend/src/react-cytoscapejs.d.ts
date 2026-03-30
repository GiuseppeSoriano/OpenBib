declare module "react-cytoscapejs" {
  import type { Component } from "react";
  import type { Core, CytoscapeOptions } from "cytoscape";

  interface CytoscapeComponentProps {
    elements: CytoscapeOptions["elements"];
    stylesheet?: CytoscapeOptions["style"];
    layout?: CytoscapeOptions["layout"];
    style?: React.CSSProperties;
    cy?: (cy: Core) => void;
    className?: string;
    [key: string]: unknown;
  }

  export default class CytoscapeComponent extends Component<CytoscapeComponentProps> {}
}
