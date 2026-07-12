// Fallback for an unmatched path.

import { createPage, useNavigate } from "@buzola/router";

export default createPage().render(function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="list-wrap">
      <div className="hero">
        <h1 className="hero-h">
          <span className="lead">Not found</span>
          <span className="em">Nothing lives here</span>
        </h1>
      </div>
      <p className="muted">That page doesn&apos;t exist. <button className="ghost sm" onClick={() => navigate("home")}>← back to pages</button></p>
    </div>
  );
});
