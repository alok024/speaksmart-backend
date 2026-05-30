const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET      = process.env.JWT_SECRET;
const FREE_LIMIT      = 30;
const PRO_PRICE_PAISE = 29900;

function getRazorpay() {
  return new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

async function sb(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=representation',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'No token' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/', (req, res) => res.json({ status: 'SpeakSmart backend running ✅' }));

// ── Register ─────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const check = await sb(`/users?email=eq.${encodeURIComponent(email)}&select=id`);
    if (check.data && check.data.length > 0)
      return res.status(409).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 10);
    const { ok, data } = await sb('/users', 'POST', { email, password_hash, plan: 'free' });
    if (!ok) return res.status(500).json({ error: 'Failed to create user' });

    const user = data[0];
    await Promise.all([
      sb('/usage', 'POST', { user_id: user.id, call_count: 0 }),
      sb('/stats', 'POST', { user_id: user.id, streak: 0, sessions: 0, best_score: 0, total_score: 0 }),
    ]);

    const token = jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Login ────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const { data: users } = await sb(`/users?email=eq.${encodeURIComponent(email)}&select=*`);
    if (!users || users.length === 0)
      return res.status(401).json({ error: 'Invalid email or password' });

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email, plan: user.plan }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Me: user + usage + stats ─────────────────────────────────
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const [{ data: users }, { data: usage }, { data: stats }] = await Promise.all([
      sb(`/users?id=eq.${req.user.id}&select=id,email,plan`),
      sb(`/usage?user_id=eq.${req.user.id}&select=call_count`),
      sb(`/stats?user_id=eq.${req.user.id}&select=*`),
    ]);

    const user = users[0];
    const callCount = usage?.[0]?.call_count || 0;
    const userStats = stats?.[0] || { streak: 0, sessions: 0, best_score: 0, total_score: 0 };

    res.json({
      user:  { id: user.id, email: user.email, plan: user.plan, ai_calls: callCount },
      usage: { call_count: callCount, limit: user.plan === 'pro' ? null : FREE_LIMIT, remaining: user.plan === 'pro' ? null : Math.max(0, FREE_LIMIT - callCount) },
      stats: userStats,
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── AI call ──────────────────────────────────────────────────
app.post('/api/ai', authMiddleware, async (req, res) => {
  try {
    const { data: users } = await sb(`/users?id=eq.${req.user.id}&select=plan`);
    const { data: usage } = await sb(`/usage?user_id=eq.${req.user.id}&select=call_count`);

    const plan      = users?.[0]?.plan || 'free';
    const callCount = usage?.[0]?.call_count || 0;

    if (plan === 'free' && callCount >= FREE_LIMIT)
      return res.status(403).json({ error: 'limit_reached', calls_used: callCount });

    await sb(`/usage?user_id=eq.${req.user.id}`, 'PATCH', {
      call_count: callCount + 1,
      updated_at: new Date().toISOString(),
    });

    const messages = [];
    if (req.body.system) messages.push({ role: 'system', content: req.body.system });
    if (req.body.messages) messages.push(...req.body.messages);

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: req.body.max_tokens || 1024, messages }),
    });

    const aiData = await aiRes.json();
    const text = aiData.choices?.[0]?.message?.content || '';
    res.json({ text, calls_used: callCount + 1, limit: plan === 'pro' ? null : FREE_LIMIT });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Save session ─────────────────────────────────────────────
app.post('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const { profession, mode, difficulty, interview_type, personality, score, exchanges, duration_secs, hindi_mode, feedbacks } = req.body;

    const { data: sessionData, ok } = await sb('/sessions', 'POST', {
      user_id: req.user.id,
      profession: profession || 'General',
      mode: mode || 'classic',
      difficulty: difficulty || 'beginner',
      interview_type: interview_type || 'mixed',
      personality: personality || 'friendly',
      score: score || 0,
      exchanges: exchanges || 0,
      duration_secs: duration_secs || 0,
      hindi_mode: hindi_mode || false,
    });

    if (!ok) return res.status(500).json({ error: 'Failed to save session' });
    const session = sessionData[0];

    if (feedbacks && feedbacks.length > 0) {
      for (const f of feedbacks) {
        await sb('/feedback', 'POST', {
          session_id:  session.id,
          question:    f.q || f.question || '',
          answer:      f.answer || '',
          score:       f.score || 0,
          corrections: JSON.stringify(f.corrections || []),
          tips:        f.tip || f.tips || '',
        });
      }
    }

    // Update stats
    const { data: statsArr } = await sb(`/stats?user_id=eq.${req.user.id}&select=*`);
    const existing = statsArr?.[0];
    const today = new Date().toDateString();
    const lastSession = existing?.last_session ? new Date(existing.last_session).toDateString() : null;
    const newStreak   = lastSession === today ? (existing?.streak || 0) : (existing?.streak || 0) + 1;
    const newSessions = (existing?.sessions || 0) + 1;
    const newBest     = Math.max(existing?.best_score || 0, score || 0);
    const newTotal    = (existing?.total_score || 0) + (score || 0);

    if (existing) {
      await sb(`/stats?user_id=eq.${req.user.id}`, 'PATCH', {
        streak: newStreak, sessions: newSessions, best_score: newBest,
        total_score: newTotal, last_session: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
    } else {
      await sb('/stats', 'POST', {
        user_id: req.user.id, streak: 1, sessions: 1,
        best_score: score || 0, total_score: score || 0, last_session: new Date().toISOString(),
      });
    }

    res.json({ success: true, session_id: session.id, streak: newStreak, sessions: newSessions, best_score: newBest });
  } catch (err) {
    console.error('Session save error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Get session history ──────────────────────────────────────
app.get('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const { data } = await sb(`/sessions?user_id=eq.${req.user.id}&order=created_at.desc&limit=20&select=*`);
    res.json({ sessions: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Razorpay ─────────────────────────────────────────────────
app.post('/api/payment/create-order', authMiddleware, async (req, res) => {
  try {
    const order = await getRazorpay().orders.create({
      amount: PRO_PRICE_PAISE, currency: 'INR',
      notes: { user_id: String(req.user.id), email: req.user.email },
    });
    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

app.post('/api/payment/verify', authMiddleware, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment verification failed' });
    await sb(`/users?id=eq.${req.user.id}`, 'PATCH', { plan: 'pro' });
    await sb(`/usage?user_id=eq.${req.user.id}`, 'PATCH', { call_count: 0 });
    const token = jwt.sign({ id: req.user.id, email: req.user.email, plan: 'pro' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, plan: 'pro' });
  } catch (err) {
    console.error('Payment verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SpeakSmart backend running on port ${PORT}`));
