const Notification = require("../models/Notification");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");

exports.getNotifications = async (req, res, next) => {
  try {
    const filter = { user: req.user.id };
    const pg = paginationParams(req);
    const notifications = await applyPagination(
      Notification.find(filter).sort({ createdAt: -1 }),
      pg
    );
    return sendList(res, notifications, pg, () => Notification.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.markAsRead = async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { read: true },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }
    res.json(notification);
  } catch (error) {
    next(error);
  }
};

exports.markAllAsRead = async (req, res, next) => {
  try {
    await Notification.updateMany(
      { user: req.user.id, read: false },
      { read: true }
    );
    res.json({ message: "All notifications marked as read" });
  } catch (error) {
    next(error);
  }
};
