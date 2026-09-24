import { useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { Provider, useSelector, useDispatch } from "react-redux";
import { store } from "./store/store";
import { initLocation } from "./store/locationSlice";
import Toasts from "./components/Toasts";
import NotificationPopup from "./components/NotificationPopup";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import ProtectedRoute from "./components/ProtectedRoute";
import ScrollToTop from "./components/ScrollToTop";
import BackToTop from "./components/BackToTop";
import FestiveOfferBillboard from "./components/FestiveOfferBillboard";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import CookProfile from "./pages/CookProfile";
import CookBooking from "./pages/CookBooking";
import CustomerDashboard from "./pages/CustomerDashboard";
import CustomerProfile from "./pages/CustomerProfile";
import BookingDetails from "./pages/BookingDetails";
import Notifications from "./pages/Notifications";
import CookDashboard from "./pages/CookDashboard";
import CookSetup from "./pages/CookSetup";
import CookReviews from "./pages/CookReviews";
import AdminDashboard from "./pages/AdminDashboard";
import AdminCookProfile from "./pages/AdminCookProfile";
import AdminComplaints from "./pages/AdminComplaints";
import BookingWaiting from "./pages/BookingWaiting";
import BookingPayment from "./pages/BookingPayment";
import { TermsConditions, PrivacyPolicy, RefundPolicy, ContactUs } from "./pages/Legal";
import "./App.css";

// Customer-only pages (Find Cooks / Book a Cook).
// Guests + customers can view; admins -> /admin, cooks -> cook dashboard.
const NonAdminRoute = ({ children }) => {
  const user = useSelector((s) => s.auth.user);
  const token = useSelector((s) => s.auth.token);
  const loading = useSelector((s) => s.auth.loading);
  if (loading) return <div className="loading">Loading...</div>;
  // Only honor the role when a real token backs it — otherwise treat as guest.
  if (!token || !user) return children;
  if (user?.role === "admin") return <Navigate to="/admin" replace />;
  if (user?.role === "cook") return <Navigate to="/dashboard/cook-bookings" replace />;
  return children;
};

// Kicks off the first-visit location bootstrap once per app mount.
const LocationBootstrap = () => {
  const dispatch = useDispatch();
  useEffect(() => {
    dispatch(initLocation());
  }, [dispatch]);
  return null;
};

// Revalidate any stored session when the app boots so a suspended/deleted
// account (or an expired token) cannot linger as a fake logged-in state.
const SessionBootstrap = () => {
  const dispatch = useDispatch();
  useEffect(() => {
    try {
      const token = localStorage.getItem("token") || sessionStorage.getItem("token");
      if (token) {
        import("./store/authSlice").then((m) => dispatch(m.fetchCurrentUser()));
      }
    } catch {
      // storage unavailable — stay logged out
    }
  }, [dispatch]);
  return null;
};

function App() {
  return (
    <Provider store={store}>
        <Router>
        <LocationBootstrap />
        <SessionBootstrap />
        <ScrollToTop />
        <div className="App">
          <FestiveOfferBillboard />
          <Navbar />
          <main className="main-content">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              {/* Compliance pages (required for payment-gateway activation) —
                  public for every role, including guests. */}
              <Route path="/terms" element={<TermsConditions />} />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route path="/refunds" element={<RefundPolicy />} />
              <Route path="/contact" element={<ContactUs />} />
              {/* Find Cooks listing removed — all discovery goes through
                  Book a Cook. Old /cooks URLs land there too. */}
              <Route
                path="/cooks"
                element={<Navigate to="/cook-on-demand" replace />}
              />
              <Route
                path="/cooks/:id"
                element={
                  <NonAdminRoute>
                    <CookProfile />
                  </NonAdminRoute>
                }
              />
              <Route
                path="/cook-on-demand"
                element={
                  <NonAdminRoute>
                    <CookBooking />
                  </NonAdminRoute>
                }
              />
              <Route
                path="/dashboard/my-bookings"
                element={
                  <ProtectedRoute roles={["customer"]}>
                    <CustomerDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard/profile"
                element={
                  <ProtectedRoute roles={["customer"]}>
                    <CustomerProfile />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard/notifications"
                element={
                  <ProtectedRoute roles={["customer", "cook"]}>
                    <Notifications />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/bookings/:bookingId"
                element={
                  <ProtectedRoute roles={["customer", "cook", "admin"]}>
                    <BookingDetails />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/bookings/:bookingId/wait"
                element={
                  <ProtectedRoute roles={["customer"]}>
                    <BookingWaiting />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/bookings/:bookingId/pay"
                element={
                  <ProtectedRoute roles={["customer"]}>
                    <BookingPayment />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard/cook-bookings"
                element={
                  <ProtectedRoute roles={["cook"]}>
                    <CookDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard/cook-profile"
                element={
                  <ProtectedRoute roles={["cook"]}>
                    <CookSetup />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard/cook-reviews"
                element={
                  <ProtectedRoute roles={["cook"]}>
                    <CookReviews />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin"
                element={
                  <ProtectedRoute roles={["admin"]}>
                    <AdminDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/cooks/:id"
                element={
                  <ProtectedRoute roles={["admin"]}>
                    <AdminCookProfile />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/complaints"
                element={
                  <ProtectedRoute roles={["admin"]}>
                    <AdminComplaints />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
          <Footer />
        </div>
        <BackToTop />
        <Toasts />
        <NotificationPopup />
      </Router>
    </Provider>
  );
}

export default App;
