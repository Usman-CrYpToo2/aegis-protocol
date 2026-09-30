import { Navigate, useParams } from "react-router-dom";

/** The bridge now lives in the asset page's action box; old links land there. */
export function BridgePage() {
  const { mint } = useParams();
  return <Navigate to={`/asset/${mint}#exchange`} replace />;
}
