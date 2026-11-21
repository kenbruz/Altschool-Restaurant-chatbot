require("dotenv").config();
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3500;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Paystack API client (uses your secret key from .env)
const paystack = axios.create({
  baseURL: "https://api.paystack.co",
  headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
});

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Each device gets a cookie, and that cookie is tied to its own session data
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 days
  })
);

// Restaurant menu (numbers start at 11 so they never clash with 1, 0, 97-100)
const MENU = [
  { id: 11, name: "Jollof Rice & Chicken", price: 3500 },
  { id: 12, name: "Fried Rice & Beef", price: 3200 },
  { id: 13, name: "Pounded Yam & Egusi", price: 4000 },
  { id: 14, name: "Suya (Large)", price: 2500 },
  { id: 15, name: "Pepper Soup", price: 3000 },
  { id: 16, name: "Chapman (Drink)", price: 1500 },
];

const MAIN_OPTIONS = [
  "Select 1 to Place an order",
  "Select 99 to checkout order",
  "Select 98 to see order history",
  "Select 97 to see current order",
  "Select 0 to cancel order",
].join("\n");

const naira = (n) => "₦" + n.toLocaleString();
const total = (items) => items.reduce((sum, i) => sum + i.price, 0);
const makeRef = () => "ORD-" + crypto.randomBytes(8).toString("hex");

function formatItems(items) {
  return items.map((i) => `- ${i.name} (${naira(i.price)})`).join("\n") + `\nTotal: ${naira(total(items))}`;
}

function menuText() {
  const lines = MENU.map((m) => `Select ${m.id} for ${m.name} - ${naira(m.price)}`);
  return "Here is our menu:\n" + lines.join("\n") + "\n\nSelect 99 to checkout, or 0 to cancel.";
}

// Set up a fresh session the first time a device visits
function init(req) {
  if (!req.session.currentOrder) req.session.currentOrder = [];
  if (!req.session.orders) req.session.orders = [];
  // Paystack needs an email, and we have no login, so each device gets a placeholder one
  if (!req.session.email) {
    req.session.email = `customer-${crypto.randomBytes(4).toString("hex")}@restaurantchatbot.com`;
  }
}

// Welcome message when the chat page loads (also shows payment results)
app.get("/api/start", (req, res) => {
  init(req);
  let reply = "Welcome to the Restaurant ChatBot!\n\n" + MAIN_OPTIONS;
  if (req.session.notice) {
    reply = req.session.notice + "\n\n" + MAIN_OPTIONS;
    req.session.notice = null;
  }
  res.json({ reply });
});

// Every customer message comes here
app.post("/api/chat", async (req, res) => {
  init(req);

  // Input validation
  const raw = req.body && req.body.message;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json({ reply: "Please send a number from the options." });
  }
  const input = raw.trim();
  if (!/^\d+$/.test(input)) {
    return res.json({ reply: "Invalid input. Please send a number only.\n\n" + MAIN_OPTIONS });
  }
  const choice = Number(input);
  let reply;
  let payUrl = null;

  if (choice === 1) {
    reply = menuText();
  } else if (choice === 99) {
    if (req.session.currentOrder.length === 0) {
      reply = "No order to place.\n\nSelect 1 to place a new order.";
    } else {
      const items = req.session.currentOrder;
      req.session.orders.push({
        items,
        total: total(items),
        status: "pending",
        reference: makeRef(),
        placedAt: new Date().toLocaleString(),
      });
      req.session.currentOrder = [];
      reply =
        `Order placed! Your total is ${naira(total(items))}.\n\n` +
        "Select 100 to pay now.\nSelect 1 to place a new order.";
    }
  } else if (choice === 100) {
    // Pay for the most recent unpaid order
    const order = [...req.session.orders].reverse().find((o) => o.status === "pending");
    if (!order) {
      reply = "You have no order waiting for payment.\n\nSelect 1 to place an order.";
    } else {
      try {
        order.reference = makeRef(); // Paystack needs a fresh reference each attempt
        const r = await paystack.post("/transaction/initialize", {
          email: req.session.email,
          amount: order.total * 100, // Paystack uses kobo
          reference: order.reference,
          callback_url: `${BASE_URL}/payment/callback`,
        });
        payUrl = r.data.data.authorization_url;
        reply = `Please pay ${naira(order.total)} using the button below.`;
      } catch (err) {
        console.error("Paystack error:", err.response ? err.response.data : err.message);
        reply = "Sorry, we could not start the payment. Please try again.";
      }
    }
  } else if (choice === 98) {
    if (req.session.orders.length === 0) {
      reply = "You have no order history yet.\n\nSelect 1 to place an order.";
    } else {
      reply =
        "Your order history:\n\n" +
        req.session.orders
          .map((o, i) => {
            const status = o.status === "paid" ? "PAID" : "AWAITING PAYMENT";
            return `Order ${i + 1} (${o.placedAt}) - ${status}\n${formatItems(o.items)}`;
          })
          .join("\n\n") +
        "\n\nSelect 100 to pay for an unpaid order.";
    }
  } else if (choice === 97) {
    reply =
      req.session.currentOrder.length === 0
        ? "You have no current order.\n\nSelect 1 to place an order."
        : "Your current order:\n" + formatItems(req.session.currentOrder) + "\n\nSelect 99 to checkout.";
  } else if (choice === 0) {
    if (req.session.currentOrder.length === 0) {
      reply = "There is no order to cancel.\n\nSelect 1 to place an order.";
    } else {
      req.session.currentOrder = [];
      reply = "Your order has been cancelled.\n\nSelect 1 to place a new order.";
    }
  } else {
    const item = MENU.find((m) => m.id === choice);
    if (item) {
      req.session.currentOrder.push(item);
      reply = `${item.name} added.\n\nSelect another item, 99 to checkout, 97 to see your order, or 0 to cancel.`;
    } else {
      reply = "Invalid option.\n\n" + MAIN_OPTIONS;
    }
  }

  res.json({ reply, payUrl });
});

// Paystack sends the customer back here after payment
app.get("/payment/callback", async (req, res) => {
  init(req);
  const reference = req.query.reference || req.query.trxref;

  if (typeof reference === "string") {
    const order = req.session.orders.find((o) => o.reference === reference);
    try {
      // Never trust the redirect alone: ask Paystack if the payment really succeeded
      const r = await paystack.get(`/transaction/verify/${encodeURIComponent(reference)}`);
      const data = r.data.data;
      if (order && data.status === "success" && data.amount === order.total * 100) {
        order.status = "paid";
        req.session.notice =
          `Payment successful! We received ${naira(order.total)}. Thank you, your meal is being prepared.`;
      } else if (data.status !== "success") {
        req.session.notice = "Payment was not completed. Select 100 to try again.";
      } else {
        req.session.notice = "We could not match this payment to an order on this device.";
      }
    } catch (err) {
      console.error("Verify error:", err.response ? err.response.data : err.message);
      req.session.notice = "We could not verify your payment. Select 98 to check your order status.";
    }
  }

  req.session.save(() => res.redirect("/"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
