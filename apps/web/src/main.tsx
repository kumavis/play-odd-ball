import { render } from "preact";
import { App } from "./app";
import { initRuntime } from "./runtime";
import "./styles.css";

render(<App />, document.getElementById("root")!);
initRuntime();
