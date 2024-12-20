import { BrowserRouter, Routes, Route } from "react-router";
import { createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";

import HomePage from "./pages/HomePage"
import SpacePage from "./pages/SpacePage"
import ArchivePage from "./pages/ArchivePage"

const theme = createTheme({
  /* mantine overrides */
})

function App() {
  return (
    <MantineProvider theme={theme}>
      <BrowserRouter>
        <Routes>
          <Route index element={<HomePage />} />
          <Route path="space">
            <Route path=":id" element={<SpacePage />} />
          </Route>
          <Route path="archive">
            <Route path=":id" element={<ArchivePage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </MantineProvider>
  );
}

export default App;
