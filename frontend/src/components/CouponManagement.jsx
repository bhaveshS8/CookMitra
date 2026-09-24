// CouponManagement — admin Coupons tab: list, create, edit, activate/deactivate,
// delete (server refuses deleting redeemed coupons — deactivate instead).
import React, { useState } from "react";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { useShowToast } from "../store/hooks";
import { formatDate } from "../utils/constants";
import CouponModal from "./CouponModal";
import ConfirmDialog from "./ConfirmDialog";
import { Plus, Pencil, Trash2, Power, PowerOff } from "lucide-react";

const CouponManagement = () => {
  const { data: coupons, loading, refetch } = useFetch("/coupons");
  const showToast = useShowToast();
  const [showModal, setShowModal] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const openCreate = () => {
    setEditingCoupon(null);
    setShowModal(true);
  };
  const openEdit = (coupon) => {
    setEditingCoupon(coupon);
    setShowModal(true);
  };

  const handleToggle = async (coupon) => {
    try {
      await API.patch(`/coupons/${coupon._id}`, { active: !coupon.active });
      showToast(
        coupon.active
          ? `Coupon ${coupon.code} deactivated — hidden from customers.`
          : `Coupon ${coupon.code} activated — live for customers.`,
        "success"
      );
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Update failed", "error");
    }
  };

  const handleDelete = async () => {
    const coupon = pendingDelete;
    if (!coupon) return;
    setPendingDelete(null);
    try {
      await API.delete(`/coupons/${coupon._id}`);
      showToast(`Coupon ${coupon.code} deleted`, "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Delete failed", "error");
    }
  };

  const now = Date.now();
  const statusBadge = (c) => {
    if (c.active === false) return <span className="badge badge-rose">INACTIVE</span>;
    if (c.validTo && new Date(c.validTo).getTime() < now) return <span className="badge badge-amber">EXPIRED</span>;
    if (c.validFrom && new Date(c.validFrom).getTime() > now) return <span className="badge badge-amber">SCHEDULED</span>;
    return <span className="badge badge-emerald">ACTIVE</span>;
  };

  const windowLabel = (c) => {
    const from = c.validFrom ? formatDate(c.validFrom) : "now";
    const to = c.validTo ? formatDate(c.validTo) : "no expiry";
    return c.validFrom || c.validTo ? `${from} → ${to}` : "Always";
  };
  const usageLabel = (c) => {
    const used = Number(c.usedCount || 0);
    const limit = c.usageLimit != null ? ` / ${c.usageLimit}` : "";
    const per = c.perUserLimit != null ? `${c.perUserLimit}x / user` : "unlimited / user";
    return `${used}${limit} used • ${per}`;
  };

  return (
    <div>
      <div className="admin-section-head">
        <div>
          <h2>Promo Coupons</h2>
          <p className="admin-section-sub">
            Create, edit or retire discount codes. Active offers appear on the home page automatically.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>
          <Plus size={16} /> New Coupon
        </button>
      </div>

      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading coupons...</p>
        </div>
      ) : coupons && coupons.length > 0 ? (
        <div className="admin-table-card">
          <table className="admin-table coupon-table">
            <thead>
              <tr>
                <th>Coupon</th>
                <th>Discount</th>
                <th>Limits</th>
                <th>Window</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((c) => (
                <tr key={c._id}>
                  <td data-label="Coupon">
                    <span className="coupon-code-chip">{c.code}</span>
                    {c.description ? <div className="coupon-desc">{c.description}</div> : null}
                  </td>
                  <td data-label="Discount">
                    <div className="coupon-pct">
                      {c.discountType === "flat" ? `₹${c.flatAmount} OFF` : `${c.percent}% OFF`}
                    </div>
                    <div className="coupon-sub">
                      {c.discountType === "flat"
                        ? "flat discount"
                        : c.maxDiscount != null ? `max ₹${c.maxDiscount}` : "uncapped"}
                      {c.minOrder > 0 ? ` • min ₹${c.minOrder}` : ""}
                      {c.firstBookingOnly ? " • 1st booking" : ""}
                    </div>
                  </td>
                  <td data-label="Limits">
                    <div className="coupon-desc">{usageLabel(c)}</div>
                  </td>
                  <td data-label="Window" className="admin-td-nowrap">{windowLabel(c)}</td>
                  <td data-label="Status">{statusBadge(c)}</td>
                  <td data-label="Actions">
                    <div className="admin-actions">
                      <button className="btn btn-outline btn-sm" onClick={() => openEdit(c)} title="Edit coupon">
                        <Pencil size={15} /> Edit
                      </button>
                      <button
                        className={`btn btn-sm ${c.active === false ? "btn-primary" : "btn-outline"}`}
                        onClick={() => handleToggle(c)}
                        title={c.active === false ? "Activate this coupon" : "Deactivate this coupon"}
                      >
                        {c.active === false ? <><Power size={15} /> Activate</> : <><PowerOff size={15} /> Deactivate</>}
                      </button>
                      <button className="btn btn-danger-outline btn-sm" onClick={() => setPendingDelete(c)} title="Delete coupon (only when never used)">
                        <Trash2 size={15} /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="admin-bookings-empty">
          <p>No coupons yet — create the first one!</p>
        </div>
      )}

      <CouponModal
        open={showModal}
        coupon={editingCoupon}
        onClose={() => setShowModal(false)}
        onSaved={() => {
          setShowModal(false);
          refetch();
        }}
      />
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete coupon ${pendingDelete?.code}?`}
        message="This cannot be undone (coupons that were already used are kept instead)."
        confirmLabel="Delete coupon"
        tone="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
};

export default CouponManagement;