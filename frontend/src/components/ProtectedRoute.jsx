import { Navigate, useLocation } from "react-router-dom";
import { useSelector } from "react-redux";

const ProtectedRoute = ({ children, roles }) => {
  const user = useSelector((s) => s.auth.user);
  const token = useSelector((s) => s.auth.token);
  const loading = useSelector((s) => s.auth.loading);
  const location = useLocation();

  if (loading) return <div className="loading">Loading...</div>;
  // Require BOTH a user and a token — a forged localStorage user object
  // alone must never open a protected page.
  if (!user || !token) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
};

export default ProtectedRoute;
