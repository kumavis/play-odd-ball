import { TopBar } from "./components/TopBar";
import { PatchBay } from "./components/PatchBay";
import { Drawer } from "./components/panels";
import { ConnEditor } from "./components/ConnEditor";
import { GestureEditor } from "./components/GestureEditor";
import { Hint } from "./components/Hint";

export function App() {
  return (
    <>
      <TopBar />
      <main class="workspace">
        <PatchBay />
        <Drawer />
      </main>
      <ConnEditor />
      <GestureEditor />
      <Hint />
    </>
  );
}
