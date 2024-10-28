const express = require('express');
const bodyParser = require('body-parser');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
const moment = require('moment-timezone');
const geoip = require('geoip-lite');
const path = require('path');
const bcrypt = require('bcrypt');
const requestIp = require('request-ip');
const UAParser = require('ua-parser-js');
const NodeCache = require('node-cache');
const http = require('http');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const fetch = require('node-fetch');
const axios = require('axios');
const cron = require('node-cron');
const app = express();
const PORT = process.env.PORT || 8000;
const msgRetryCounterCache = new NodeCache();
require('dotenv').config();

let sock = null;
let isConnecting = false;
let connectionTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 5000; // 5 seconds
const CONNECTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Database and session configuration
const dbConfig = {
    host: 'sv82.ifastnet.com',
    user: 'crossgig_drovetest3',
    password: '3800380@Hamza',
    database: 'crossgig_drovetest3',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const sessionStore = new MySQLStore(dbConfig);

// Express configuration
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('public'));
app.use(session({
    key: 'talkdrove-session',
    secret: '3800380',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
}));

const pool = mysql.createPool(dbConfig);
app.set('view engine', 'ejs');
// All database:::


async function initDatabase() {
    try {
        const connection = await pool.getConnection();
            // Finalizing
        connection.release();
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
}
const sessionPath = path.join(__dirname, 'session/');
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath); // Create session folder if it doesn’t exist
}

// Improved WhatsApp Connection Functions
async function createWAConnection() {
    if (isConnecting) {
        console.log('Connection attempt already in progress');
        return null;
    }

    try {
        isConnecting = true;
        reconnectAttempts++;

        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const socket = makeWASocket({
            version,
            logger: P({ level: 'silent' }),
            printQRInTerminal: true,
            auth: state,
            msgRetryCounterCache
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

                console.log('Connection closed due to:', lastDisconnect?.error?.message);

                if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    console.log(`Reconnecting... Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

                    // Clear any active timeout
                    if (connectionTimeout) {
                        clearTimeout(connectionTimeout);
                    }

                    // Reset connection and attempt to reconnect after the interval
                    sock = null;
                    setTimeout(async () => {
                        sock = await createWAConnection();
                    }, RECONNECT_INTERVAL);

                } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.error("Max reconnect attempts reached. Connection failed.");
                    reconnectAttempts = 0;
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connection established successfully');
                reconnectAttempts = 0; // Reset reconnect attempts upon successful connection
            }
        });

        socket.ev.on('creds.update', saveCreds);
        return socket;
    } catch (error) {
        console.error('Error creating WhatsApp connection:', error);
        return null;
    } finally {
        isConnecting = false;
    }
}
async function getWAConnection() {
    if (!sock) {
        sock = await createWAConnection();
    }
    return sock;
}
async function closeWAConnection() {
    if (sock) {
        try {
            console.log('Closing WhatsApp connection...');
            await sock.logout();
            await sock.end();
            sock = null;
            console.log('WhatsApp connection closed successfully');
        } catch (error) {
            console.error('Error closing WhatsApp connection:', error);
        }
    }
    if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
    }
    reconnectAttempts = 0; // Reset reconnect attempts
}
Promise.all([initDatabase()])
    .then(() => console.log('Bot connected and database initialized'))
    .catch(err => console.log('Error during initialization:', err));
// In-memory storage for verification codes
const verificationCodes = {};

// Middleware to check if user is logged in
function isLoggedIn(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}
// Add these middleware functions at the top of your routes
const checkUserCoins = async (req, res, next) => {
    try {
        const [userRows] = await pool.query(
            'SELECT coins FROM users WHERE phone_number = ?',
            [req.session.user.phoneNumber]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        req.userCoins = userRows[0].coins;
        next();
    } catch (error) {
        console.error('Error checking user coins:', error);
        res.status(500).json({ error: 'Failed to check user coins' });
    }
};

function isAdmin(req, res, next) {
    console.log('Session data:', req.session);
    console.log('User data:', req.session.user);
    console.log('Is admin?:', req.session.user?.is_admin);

    if (req.session.user && req.session.user.is_admin === true) {
        next();
    } else {
        res.status(403).json({
            error: 'Access denied',
            debug: {
                hasSession: !!req.session,
                hasUser: !!req.session?.user,
                adminStatus: req.session?.user?.is_admin
            }
        });
    }
}

// Serve static files
app.use(express.static('public'));
// Main routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'front-end', 'lander.html'));
});
// Main routes
app.get('/dashboard', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});
app.get('/admin/add-heroku', isLoggedIn, isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'add-heroku.html'));
});
app.get('/dashboard/account-settings', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'account-settings.html'));
});
app.get('/dashboard/buy-heroku', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'buy-heroku.html'));
});
app.get('/dashboard/my-heroku', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'my-heroku.html'));
});
// Route to serve the HTML pages
app.get('/dashboard/new-bot/', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bot-request.html'));
});

app.get('/dashboard/my-bots/', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'my-bots.html'));
});

// Separate route for login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Separate route for registration page
app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/dashboard/wallet', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'wallet.html'));
});
// Admin panel main page
app.get('/admin', isAdmin, isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'admin.html'));
});


// api keys
app.get('/admin/add-apikeys', isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'add-apikeys.html'));
});
app.get('/dashboard/invite', isLoggedIn, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'invite', 'invite.html'));
});
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'front-end', 'privacy.html'));
});
app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'front-end', 'terms-of-service.html'));
});
// Check if phone number exists in database
app.post('/check-phone', async (req, res) => {
    const { phoneNumber } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE phone_number = ?', [phoneNumber]);
        if (rows.length > 0) {
            res.json({ success: true, message: 'Phone number exists.' });
        } else {
            res.json({ success: false, message: 'User not found. Proceeding with registration.' });
        }
    } catch (error) {
        console.error('Error checking phone number:', error);
        res.status(500).json({ success: false, message: 'An error occurred while checking the phone number.' });
    }
});
// Utility function to check internet connectivity
async function checkInternetConnectivity() {
    try {
        const dns = require('dns').promises;
        await dns.lookup('api.heroku.com');
        return true;
    } catch (error) {
        console.error('DNS lookup failed:', error);
        return false;
    }
}

app.post('/send-code', async (req, res) => {
    const { phoneNumber, isRegistering } = req.body;

    try {
        // Generate verification code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Store verification data
        verificationCodes[phoneNumber] = {
            code: verificationCode,
            timestamp: Date.now(),
            attempts: 0,
            isRegistering: isRegistering,
            phoneNumber: phoneNumber
        };

        const waSocket = await getWAConnection();

        // Check if the socket is connected
        if (!waSocket) {
            throw new Error('Failed to establish WhatsApp connection');
        }

        // Format the message properly for Baileys
        const formattedMessage = {
            text: `🔒 Your TalkDrove verification code is: ${verificationCode}\n\n` +
                  `This code will expire in 30 minutes.\n` +
                  `Do not share this code with anyone.`
        };

        // Sending message
        try {
            await waSocket.sendMessage(
                `${phoneNumber}@s.whatsapp.net`,
                formattedMessage
            );
            res.json({
                success: true,
                message: 'Verification code sent successfully'
            });
        } catch (sendError) {
            console.error('Error in sending message:', sendError);
            res.status(500).json({
                success: false,
                message: 'Failed to send WhatsApp message',
                error: sendError.message
            });
        }

    } catch (error) {
        console.error('Error sending verification code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send verification code',
            error: error.message
        });
    }
});


// Normalize IP for comparison
const normalizeIp = (ip) => {
    if (!ip) return null;
    if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
    return ip.replace(/^::ffff:/, '');
};
// Helper function to get device info
function getDeviceInfo(req) {
    const ua = new UAParser(req.headers['user-agent']);
    return {
        browser: ua.getBrowser().name,
        os: ua.getOS().name,
        device: ua.getDevice().type || 'desktop'
    };
}

// Helper function to get real IP address
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];

    if (forwarded) {
        const ips = forwarded.split(',').map(ip => ip.trim());
        return ips[0];
    }

    return requestIp.getClientIp(req) ||
        req.headers['x-real-ip'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress;
}

// Helper function to generate secure verification code
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Add rate limiting middleware
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per IP
    message: { error: 'Too many login attempts. Please try again later.' }
});

app.post('/login', loginLimiter, async (req, res) => {
    const { phoneNumber, password } = req.body;

    try {
        const [users] = await pool.query('SELECT * FROM users WHERE phone_number = ?', [phoneNumber]);

        if (users.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }

        const user = users[0];
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.status(400).json({ error: 'Invalid password' });
        }

        const clientIp = getClientIp(req);
        const deviceInfo = getDeviceInfo(req);
        const geo = geoip.lookup(clientIp);
        const normalizedClientIp = normalizeIp(clientIp);

        const [knownDevices] = await pool.query(
            'SELECT * FROM user_devices WHERE user_id = ? AND ip_address = ? AND is_verified = 1',
            [user.id, normalizedClientIp]
        );

        const isKnownDevice = knownDevices.length > 0;

        if (!isKnownDevice) {
            const verificationCode = generateVerificationCode();
            const deviceId = crypto.randomUUID();

            verificationCodes[phoneNumber] = {
                code: verificationCode,
                timestamp: Date.now(),
                attempts: 0,
                deviceId,
                deviceInfo,
                pendingIp: normalizedClientIp,
                location: geo ? `${geo.city}, ${geo.country}` : 'Unknown'
            };

            await pool.query(
                'INSERT INTO user_devices (id, user_id, ip_address, device_info, location, last_used, is_verified) VALUES (?, ?, ?, ?, ?, NOW(), 0)',
                [deviceId, user.id, normalizedClientIp, JSON.stringify(deviceInfo), verificationCodes[phoneNumber].location]
            );

            const waSocket = await getWAConnection();
            if (!waSocket) {
                throw new Error('Failed to establish WhatsApp connection');
            }

            const message = {
                text: `🔐 New login attempt detected!\n\n` +
                    `📱 Device: ${deviceInfo.device} (${deviceInfo.os})\n` +
                    `🌍 Location: ${verificationCodes[phoneNumber].location}\n` +
                    `🔑 Your verification code is: ${verificationCode}\n\n` +
                    `If this wasn't you, please change your password immediately.`,
                footer: 'Security notification',
                templateButtons: [
                    {
                        quickReplyButton: {
                            displayText: verificationCode,
                            id: `copy-code-${verificationCode}`,
                        }
                    }
                ]
            };

            await waSocket.sendMessage(`${phoneNumber}@s.whatsapp.net`, message);

            return res.json({
                success: true,
                message: 'Verification required',
                requireVerification: true,
                deviceInfo: {
                    device: deviceInfo.device,
                    browser: deviceInfo.browser,
                    location: verificationCodes[phoneNumber].location
                }
            });
        }

        await pool.query(
            'UPDATE user_devices SET last_used = NOW() WHERE user_id = ? AND ip_address = ?',
            [user.id, normalizedClientIp]
        );

        req.session.user = {
            id: user.id,
            phoneNumber: user.phone_number,
            isVerified: user.is_verified,
            is_admin: user.is_admin === 1,
            deviceId: knownDevices[0].id
        };

        res.json({
            success: true,
            message: 'Login successful',
            deviceInfo: {
                device: deviceInfo.device,
                browser: deviceInfo.browser,
                location: geo ? `${geo.city}, ${geo.country}` : 'Unknown'
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'An error occurred during login' });
    }
});
// Modified verify endpoint
app.post('/verify', async (req, res) => {
    const { phoneNumber, code, password } = req.body;

    try {
        const verification = verificationCodes[phoneNumber];

        if (!verification) {
            return res.status(400).json({
                success: false,
                message: 'No verification pending or code expired'
            });
        }

        // Check expiration (30 minutes)
        if (Date.now() - verification.timestamp > 30 * 60 * 1000) {
            delete verificationCodes[phoneNumber];
            return res.status(400).json({
                success: false,
                message: 'Verification code expired'
            });
        }

        // Check attempts
        if (verification.attempts >= 5) {
            delete verificationCodes[phoneNumber];
            return res.status(400).json({
                success: false,
                message: 'Too many failed attempts'
            });
        }

        // Verify code
        if (verification.code !== code) {
            verification.attempts++;
            return res.status(400).json({
                success: false,
                message: 'Invalid code',
                attemptsLeft: 5 - verification.attempts
            });
        }

        // Handle Registration
        if (verification.isRegistering) {
            const hashedPassword = await bcrypt.hash(password, 10);
            const [result] = await pool.query(
                'INSERT INTO users (phone_number, password, is_verified, created_at) VALUES (?, ?, 1, NOW())',
                [phoneNumber, hashedPassword]
            );

            req.session.user = {
                id: result.insertId,
                phoneNumber: phoneNumber,
                isVerified: true,
                is_admin: false
            };

            // Clear verification data after successful registration
            delete verificationCodes[phoneNumber];

            return res.json({
                success: true,
                message: 'Registration successful!',
                user: {
                    phoneNumber: phoneNumber,
                    isVerified: true
                }
            });
        }

        // Handle Login
        const [users] = await pool.query(
            'SELECT * FROM users WHERE phone_number = ?',
            [phoneNumber]
        );

        if (users.length === 0) {
            return res.status(400).json({ success: false, message: 'User not found' });
        }

        const user = users[0];

        // You may want to validate the password here, 
        // if it's a login. For example:
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(400).json({ success: false, message: 'Invalid password' });
        }

        req.session.user = {
            id: user.id,
            phoneNumber: user.phone_number,
            isVerified: user.is_verified,
            is_admin: user.is_admin === 1
        };

        // Clear verification data after successful login
        delete verificationCodes[phoneNumber];

        res.json({
            success: true,
            message: 'Login successful!',
            user: {
                phoneNumber: phoneNumber,
                isVerified: true
            }
        });

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred during verification',
            error: error.message
        });
    }
});

app.get('/check-admin', (req, res) => {
    // console.log('Current session:', req.session);
    res.json({
        isAdmin: req.session.user?.is_admin === true,
        sessionData: req.session
    });
});
// Backend route (add to your existing Express app)
app.post('/update-user', async (req, res) => {
    const { currentPassword, newPassword, name } = req.body;
    const userId = req.session.user.id;

    try {
        // Get current user data
        const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);

        if (users.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }

        const user = users[0];

        // Verify current password
        const passwordMatch = await bcrypt.compare(currentPassword, user.password);
        if (!passwordMatch) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }

        // Prepare update query parts
        let updateQuery = 'UPDATE users SET';
        const updateValues = [];

        if (name) {
            updateQuery += ' name = ?';
            updateValues.push(name);
        }

        if (newPassword) {
            if (name) updateQuery += ',';
            updateQuery += ' password = ?';
            const hashedNewPassword = await bcrypt.hash(newPassword, 10);
            updateValues.push(hashedNewPassword);
        }

        updateQuery += ' WHERE id = ?';
        updateValues.push(userId);

        // Execute update
        await pool.query(updateQuery, updateValues);

        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({ error: 'An error occurred while updating profile' });
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.redirect('/login');
    });
});

// Check login status route
app.get('/check-login', (req, res) => {
    if (req.session.user) {
        res.status(200).json({ loggedIn: true });
    } else {
        res.status(401).json({ loggedIn: false });
    }
});
async function storeUserLocation(req, res, next) {
    try {
        if (!req.session.user) {
            return next();
        }

        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
            req.connection.remoteAddress.replace('::ffff:', '');

        // First try geoip-lite
        const geo = geoip.lookup(ip);

        // If local IP or geoip fails, use ip-api as fallback
        if (!geo || ip === '127.0.0.1' || ip.startsWith('192.168.')) {
            try {
                const response = await axios.get(`http://ip-api.com/json/${ip}`);
                if (response.data.status === 'success') {
                    const userTimeZone = response.data.timezone;
                    const countryCode = response.data.countryCode;

                    // Update user's timezone and country in database
                    await pool.query(
                        'UPDATE users SET timezone = ?, country_code = ? WHERE phone_number = ?',
                        [userTimeZone, countryCode, req.session.user.phoneNumber]
                    );
                }
            } catch (error) {
                console.error('Error fetching location from ip-api:', error);
            }
        } else {
            // Use geoip-lite data
            await pool.query(
                'UPDATE users SET timezone = ?, country_code = ? WHERE phone_number = ?',
                [geo.timezone, geo.country, req.session.user.phoneNumber]
            );
        }
    } catch (error) {
        console.error('Error storing user location:', error);
    }
    next();
}

// Add the middleware to your app
app.use(storeUserLocation);

// Update the claim-coins route
app.post('/claim-coins', isLoggedIn, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const dailyCoins = 10;

        // Get user data including timezone
        const [userRows] = await connection.query(
            'SELECT last_claim_time, coins, timezone, country_code FROM users WHERE phone_number = ? FOR UPDATE',
            [req.session.user.phoneNumber]
        );

        if (userRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userRows[0];
        const userTimeZone = user.timezone || 'UTC';

        // Get current time in user's timezone
        const currentTime = moment().tz(userTimeZone);
        const lastClaimTime = user.last_claim_time ? moment(user.last_claim_time).tz(userTimeZone) : null;

        // Get start of day in user's timezone
        const startOfDay = currentTime.clone().startOf('day');
        const endOfDay = currentTime.clone().endOf('day');

        // Check if user has claimed today
        if (lastClaimTime && lastClaimTime.isSame(currentTime, 'day')) {
            await connection.rollback();
            // Calculate time until next claim (start of next day in user's timezone)
            const nextClaimTime = startOfDay.clone().add(1, 'day');
            return res.status(400).json({
                message: 'You can only claim coins once per day',
                nextClaimTime: nextClaimTime.format(),
                error: true
            });
        }

        // Update coins and last claim time
        await connection.query(
            'UPDATE users SET coins = coins + ?, last_claim_time = ? WHERE phone_number = ?',
            [dailyCoins, currentTime.format('YYYY-MM-DD HH:mm:ss'), req.session.user.phoneNumber]
        );

        await connection.commit();

        // Next claim time will be start of next day in user's timezone
        const nextClaimTime = startOfDay.clone().add(1, 'day');

        res.status(200).json({
            message: `${dailyCoins} coins claimed successfully`,
            currentCoins: user.coins + dailyCoins,
            nextClaimTime: nextClaimTime.format()
        });

    } catch (error) {
        await connection.rollback();
        console.error('Error claiming coins:', error);
        res.status(500).json({
            message: 'An error occurred while claiming coins',
            error: true
        });
    } finally {
        connection.release();
    }
});

// Update the check-claim-status route
app.get('/check-claim-status', isLoggedIn, async (req, res) => {
    try {
        const [userRows] = await pool.query(
            'SELECT last_claim_time, timezone, country_code FROM users WHERE phone_number = ?',
            [req.session.user.phoneNumber]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userRows[0];
        const userTimeZone = user.timezone || 'UTC';

        // Get times in user's timezone
        const currentTime = moment().tz(userTimeZone);
        const lastClaimTime = user.last_claim_time ? moment(user.last_claim_time).tz(userTimeZone) : null;
        const startOfDay = currentTime.clone().startOf('day');

        // If never claimed or last claim was not today
        if (!lastClaimTime || !lastClaimTime.isSame(currentTime, 'day')) {
            return res.json({
                canClaim: true,
                nextClaimTime: null
            });
        }

        // Calculate next claim time (start of next day in user's timezone)
        const nextClaimTime = startOfDay.clone().add(1, 'day');

        res.json({
            canClaim: false,
            nextClaimTime: nextClaimTime.format()
        });
    } catch (error) {
        console.error('Error checking claim status:', error);
        res.status(500).json({ error: 'An error occurred while checking claim status' });
    }
});















// Rest of the codeee

// Generate a unique invite code
function generateInviteCode() {
    return Math.random().toString(36).substring(2, 10);
}
// New route to generate an invite link
app.post('/generate-invite', isLoggedIn, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const inviteCode = generateInviteCode();

        await pool.query('INSERT INTO invites (inviter_id, invite_code) VALUES (?, ?)', [userId, inviteCode]);

        const inviteLink = `${req.protocol}://${req.get('host')}/signup?invite=${inviteCode}`;
        res.json({ inviteLink });
    } catch (error) {
        console.error('Error generating invite:', error);
        res.status(500).json({ error: 'An error occurred while generating the invite' });
    }
});


// New route to get user's invite history
app.get('/invite-history', isLoggedIn, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [invites] = await pool.query(`
            SELECT i.invite_code, i.used, i.created_at, u.phone_number as invited_user
            FROM invites i
            LEFT JOIN users u ON u.referrer_id = i.inviter_id
            WHERE i.inviter_id = ?
            ORDER BY i.created_at DESC
        `, [userId]);

        res.json(invites);
    } catch (error) {
        console.error('Error fetching invite history:', error);
        res.status(500).json({ error: 'An error occurred while fetching invite history' });
    }
});


app.get('/current-user', (req, res) => {
    if (globalUserPhoneNumber) {
        res.json({ phoneNumber: globalUserPhoneNumber });
    } else {
        res.status(401).json({ error: 'No user logged in' });
    }
});

// New API endpoint for getting all apps
// app.get('/all-userapps', async (req, res) => {
//     try {
//         const [apps] = await pool.query(`
//             SELECT users.phone_number, deployed_apps.app_name, deployed_apps.deployed_at 
//             FROM deployed_apps 
//             JOIN users ON deployed_apps.user_id = users.id
//         `);
//         res.json(apps);
//     } catch (error) {
//         console.error('Error fetching all user apps:', error);
//         res.status(500).json({ error: 'An error occurred while fetching user apps' });
//     }
// });

app.get('/app-details/:appName', isLoggedIn, async (req, res) => {
    try {
        const appName = req.params.appName;
        const [app] = await pool.execute('SELECT * FROM deployed_apps WHERE app_name = ?', [appName]);
        if (app.length === 0) {
            return res.status(404).send('App not found');
        }
        res.render('app-details', { app: app[0] });
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});




// Sensitive vars to exclude from response
const SENSITIVE_VARS = ['HEROKU_API_KEY', 'HEROKU_APP_NAME'];


app.get('/api/config-vars/:appName', async (req, res) => {
    const appName = req.params.appName;
    let connection;

    try {
        connection = await pool.getConnection();

        // Fetch active API keys from database
        const [apiKeys] = await connection.query(
            'SELECT api_key FROM heroku_api_keys WHERE is_active = true'
        );

        let configVars = null;
        let lastError = null;

        for (const { api_key } of apiKeys) {
            try {
                const response = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
                    headers: {
                        Authorization: `Bearer ${api_key}`,
                        Accept: 'application/vnd.heroku+json; version=3',
                    },
                });
                configVars = response.data;
                break;
            } catch (error) {
                lastError = error;
                continue; // Try next API key
            }
        }

        if (configVars) {
            // Filter out sensitive variables
            const filteredVars = Object.fromEntries(
                Object.entries(configVars).filter(([key]) => !SENSITIVE_VARS.includes(key))
            );
            res.json(filteredVars);
        } else {
            throw lastError || new Error('Failed to fetch config vars');
        }
    } catch (error) {
        console.error('Error fetching config vars:', error);
        res.status(500).send(`Failed to fetch config vars: ${error.message}`);
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseError) {
                console.error('Error releasing connection:', releaseError);
            }
        }
    }
});

app.post('/api/config-vars/:appName', async (req, res) => {
    const appName = req.params.appName;
    const updatedVars = req.body;
    let connection;

    try {
        connection = await pool.getConnection();

        // Fetch active API keys from database
        const [apiKeys] = await connection.query(
            'SELECT api_key FROM heroku_api_keys WHERE is_active = true'
        );

        let updated = false;
        let lastError = null;

        for (const { api_key } of apiKeys) {
            try {
                const response = await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, updatedVars, {
                    headers: {
                        Authorization: `Bearer ${api_key}`,
                        Accept: 'application/vnd.heroku+json; version=3',
                    },
                });
                updated = true;
                res.json(response.data);
                break;
            } catch (error) {
                lastError = error;
                continue; // Try next API key
            }
        }

        if (!updated) {
            throw lastError || new Error('Failed to update config vars');
        }
    } catch (error) {
        console.error('Error updating config vars:', error);
        res.status(500).send(`Failed to update config vars: ${error.message}`);
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseError) {
                console.error('Error releasing connection:', releaseError);
            }
        }
    }
});
// Modified deleteApp function with better error handling
async function deleteApp(appName) {
    let connection;
    try {
        // Check internet connectivity first
        const isConnected = await checkInternetConnectivity();
        if (!isConnected) {
            throw new Error('No internet connection or DNS resolution failed for api.heroku.com');
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // First, get the deployment ID
        const [deploymentRows] = await connection.query(
            'SELECT id FROM deployed_apps WHERE app_name = ?',
            [appName]
        );

        if (deploymentRows.length === 0) {
            await connection.commit(); // Commit even if no rows found
            return {
                success: false,
                message: `App ${appName} not found in database`
            };
        }

        const deploymentId = deploymentRows[0].id;

        try {
            // Delete from deployment_history first (child table)
            await connection.query(
                'DELETE FROM deployment_history WHERE deployment_id = ?',
                [deploymentId]
            );

            // Delete from deployment_env_vars (child table)
            await connection.query(
                'DELETE FROM deployment_env_vars WHERE deployment_id = ?',
                [deploymentId]
            );

            // Try to delete from Heroku if we have internet connectivity
            let appDeleted = false;
            let lastError = null;

            if (isConnected) {
                const [apiKeys] = await connection.query(
                    'SELECT api_key FROM heroku_api_keys WHERE is_active = true'
                );

                for (const { api_key } of apiKeys) {
                    try {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

                        const response = await fetch(`https://api.heroku.com/apps/${appName}`, {
                            method: 'DELETE',
                            headers: {
                                'Authorization': `Bearer ${api_key}`,
                                'Accept': 'application/vnd.heroku+json; version=3'
                            },
                            signal: controller.signal
                        });

                        clearTimeout(timeout);

                        if (response.ok) {
                            appDeleted = true;
                            break;
                        } else {
                            const errorData = await response.json();
                            lastError = `Heroku API Error: ${errorData.message || response.statusText}`;
                        }
                    } catch (error) {
                        console.error(`Error deleting app with API key: ${api_key}`, error);
                        lastError = error.message;
                        continue; // Try next API key
                    }
                }
            }

            // Finally delete from deployed_apps (parent table)
            await connection.query(
                'DELETE FROM deployed_apps WHERE id = ?',
                [deploymentId]
            );

            await connection.commit();

            return {
                success: true,
                message: appDeleted ?
                    `App ${appName} successfully deleted from Heroku and database` :
                    `App ${appName} deleted from database${lastError ? `, but Heroku deletion failed: ${lastError}` : ''}`
            };

        } catch (error) {
            if (connection) {
                await connection.rollback();
            }
            throw error;
        }
    } catch (error) {
        console.error('Error in deleteApp:', error);

        // Try to rollback if we have an active connection
        if (connection && connection.connection._socket) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Rollback failed:', rollbackError);
            }
        }

        return {
            success: false,
            message: `Error deleting app: ${error.message}`
        };
    } finally {
        // Only release if we have an active connection
        if (connection && connection.connection._socket) {
            try {
                connection.release();
            } catch (releaseError) {
                console.error('Error releasing connection:', releaseError);
            }
        }
    }
}

// Modify the delete route to handle errors better
app.delete('/delete-app/:appName', async (req, res) => {
    const { appName } = req.params;

    try {
        // Add request timeout
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), 30000); // 30 second timeout
        });

        const deletePromise = deleteApp(appName);
        const result = await Promise.race([deletePromise, timeoutPromise]);

        if (result.success) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('Error in delete app route:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            details: error.message
        });
    }
});

// New route to get user's wallet information
app.get('/api/wallet', isLoggedIn, async (req, res) => {
    try {
        const phoneNumber = req.session.user.phoneNumber;
        const [user] = await pool.query('SELECT coins FROM users WHERE phone_number = ?', [phoneNumber]);
        const [transactions] = await pool.query(`
            SELECT * FROM coin_transactions 
            WHERE sender_phone = ? OR recipient_phone = ? 
            ORDER BY transaction_date DESC 
            LIMIT 10
        `, [phoneNumber, phoneNumber]);

        const [deployments] = await pool.query(`
            SELECT COUNT(*) as count, SUM(cost) as total_cost 
            FROM deployed_apps 
            WHERE user_id = (SELECT id FROM users WHERE phone_number = ?)
        `, [phoneNumber]);

        res.json({
            coins: user[0].coins,
            recentTransactions: transactions,
            deployments: deployments[0]
        });
    } catch (error) {
        console.error('Error fetching wallet info:', error);
        res.status(500).json({ error: 'An error occurred while fetching wallet information' });
    }
});

// New route to send coins
app.post('/api/send-coins', isLoggedIn, async (req, res) => {
    const { recipientPhone, amount } = req.body;
    const senderPhone = req.session.user.phoneNumber;

    if (senderPhone === recipientPhone) {
        return res.status(400).json({ error: 'You cannot send coins to yourself' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check sender's balance
        const [sender] = await connection.query('SELECT coins FROM users WHERE phone_number = ?', [senderPhone]);
        if (sender[0].coins < amount) {
            await connection.rollback();
            return res.status(400).json({ error: 'Insufficient coins' });
        }

        // Check if recipient exists
        const [recipient] = await connection.query('SELECT id FROM users WHERE phone_number = ?', [recipientPhone]);
        if (recipient.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Recipient not found' });
        }

        // Update sender's balance
        await connection.query('UPDATE users SET coins = coins - ? WHERE phone_number = ?', [amount, senderPhone]);

        // Update recipient's balance
        await connection.query('UPDATE users SET coins = coins + ? WHERE phone_number = ?', [amount, recipientPhone]);

        // Record transaction
        await connection.query(`
            INSERT INTO coin_transactions (sender_phone, recipient_phone, amount) 
            VALUES (?, ?, ?)
        `, [senderPhone, recipientPhone, amount]);

        await connection.commit();
        res.json({ message: 'Coins sent successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error sending coins:', error);
        res.status(500).json({ error: 'An error occurred while sending coins' });
    } finally {
        connection.release();
    }
});

// New route to deposit coins (for demonstration purposes)
app.post('/api/deposit-coins', isLoggedIn, async (req, res) => {
    const { amount } = req.body;
    const phoneNumber = req.session.user.phoneNumber;

    try {
        await pool.query('UPDATE users SET coins = coins + ? WHERE phone_number = ?', [amount, phoneNumber]);
        await pool.query(`
            INSERT INTO coin_transactions (recipient_phone, amount, transaction_type) 
            VALUES (?, ?, 'deposit')
        `, [phoneNumber, amount]);

        res.json({ message: 'Coins deposited successfully' });
    } catch (error) {
        console.error('Error depositing coins:', error);
        res.status(500).json({ error: 'An error occurred while depositing coins' });
    }
});


//All apps
app.get('/apps', isLoggedIn, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [apps] = await pool.query(`
            SELECT * 
            FROM deployed_apps 
            WHERE user_id = ?
        `, [userId]);
        res.render('apps', { apps });
    } catch (error) {
        console.error('Error fetching user apps:', error);
        res.status(500).json({ error: 'An error occurred while fetching user apps' });
    }
});




// Modify the /user-coins route
app.get('/user-coins', isLoggedIn, async (req, res) => {
    try {
        // Query the user's coins
        const [rows] = await pool.query('SELECT coins FROM users WHERE phone_number = ?', [req.session.user.phoneNumber]);

        if (rows.length > 0) {
            res.json({ coins: rows[0].coins });
        } else {
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error) {
        console.error('Error fetching user coins:', error);
        res.status(500).json({ error: 'An error occurred while fetching user coins' });
    }
});

// Get all users
app.get('/admin/users', isAdmin, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT * FROM users');
        res.json(users);
    } catch (error) {
        // console.error('Error fetching users:', error);
        res.status(500).json({ error: 'An error occurred while fetching users' });
    }
});

// Update user coins
app.put('/admin/users/:id/coins', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { coins } = req.body;
    try {
        await pool.query('UPDATE users SET coins = ? WHERE id = ?', [coins, id]);
        res.json({ message: 'User coins updated successfully' });
    } catch (error) {
        console.error('Error updating user coins:', error);
        res.status(500).json({ error: 'An error occurred while updating user coins' });
    }
});

// Delete user
app.delete('/admin/users/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM users WHERE id = ?', [id]);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'An error occurred while deleting the user' });
    }
});


// Add new bot
app.post('/admin/bots', isAdmin, async (req, res) => {
    const { name, repoUrl, deploymentCost, envVars } = req.body;
    try {
        const [result] = await pool.query('INSERT INTO bots (name, repo_url, deployment_cost) VALUES (?, ?, ?)', [name, repoUrl, deploymentCost]);
        const botId = result.insertId;

        for (const envVar of envVars) {
            await pool.query('INSERT INTO bot_env_vars (bot_id, var_name, var_description) VALUES (?, ?, ?)', [botId, envVar.name, envVar.description]);
        }

        res.json({ message: 'Bot added successfully', botId });
    } catch (error) {
        console.error('Error adding bot:', error);
        res.status(500).json({ error: 'An error occurred while adding the bot' });
    }
});

// Delete bot
app.delete('/admin/bots/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM bot_env_vars WHERE bot_id = ?', [id]);
        await pool.query('DELETE FROM bots WHERE id = ?', [id]);
        res.json({ message: 'Bot deleted successfully' });
    } catch (error) {
        console.error('Error deleting bot:', error);
        res.status(500).json({ error: 'An error occurred while deleting the bot' });
    }
});

// Here

// Modified bot request submission endpoint
app.post('/bot-request', isLoggedIn, async (req, res) => {
    const { name, repoUrl, envVars, deploymentCost, websiteUrl } = req.body;
    const devNumber = req.session.user.phoneNumber;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Insert bot request with website URL
        const [result] = await connection.query(
            'INSERT INTO bot_requests (name, repo_url, dev_number, deployment_cost, website_url, status) VALUES (?, ?, ?, ?, ?, ?)',
            [name, repoUrl, devNumber, deploymentCost, websiteUrl, 'pending']
        );
        const requestId = result.insertId;

        // Insert environment variables
        for (const envVar of envVars) {
            await connection.query(
                'INSERT INTO bot_request_env_vars (request_id, var_name, var_description) VALUES (?, ?, ?)',
                [requestId, envVar.name, envVar.description]
            );
        }

        await connection.commit();
        res.json({
            success: true,
            message: 'Bot request submitted successfully',
            requestId
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error submitting bot request:', error);
        res.status(500).json({ error: 'An error occurred while submitting the bot request' });
    } finally {
        connection.release();
    }
});

// Get user's bot requests
app.get('/my-bot-requests', isLoggedIn, async (req, res) => {
    try {
        const [requests] = await pool.query(`
            SELECT br.*, 
                   GROUP_CONCAT(DISTINCT CONCAT(bre.var_name, ':', bre.var_description) SEPARATOR '||') as env_vars
            FROM bot_requests br
            LEFT JOIN bot_request_env_vars bre ON br.id = bre.request_id
            WHERE br.dev_number = ?
            GROUP BY br.id
            ORDER BY br.created_at DESC
        `, [req.session.user.phoneNumber]);

        const formattedRequests = requests.map(request => ({
            ...request,
            env_vars: request.env_vars ? request.env_vars.split('||').map(env => {
                const [name, description] = env.split(':');
                return { name, description };
            }) : []
        }));

        res.json(formattedRequests);
    } catch (error) {
        console.error('Error fetching bot requests:', error);
        res.status(500).json({ error: 'An error occurred while fetching bot requests' });
    }
});

app.get('/bot-request/:id', isLoggedIn, async (req, res) => {
    try {
        const [request] = await pool.query(`
            SELECT br.*, 
                   GROUP_CONCAT(DISTINCT CONCAT(bre.var_name, ':', bre.var_description) SEPARATOR '||') as env_vars
            FROM bot_requests br
            LEFT JOIN bot_request_env_vars bre ON br.id = bre.request_id
            WHERE br.id = ? AND br.dev_number = ?
            GROUP BY br.id
        `, [req.params.id, req.session.user.phoneNumber]);

        if (!request[0]) {
            return res.status(404).json({ error: 'Bot request not found' });
        }

        const formattedRequest = {
            ...request[0],
            env_vars: request[0].env_vars ? request[0].env_vars.split('||').map(env => {
                const [name, description] = env.split(':');
                return { name, description };
            }) : []
        };

        res.json(formattedRequest);
    } catch (error) {
        console.error('Error fetching bot request:', error);
        res.status(500).json({ error: 'An error occurred while fetching the bot request' });
    }
});

// Delete endpoint
app.delete('/bot-request/:id', isLoggedIn, async (req, res) => {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Verify the bot belongs to the user
        const [request] = await connection.query(
            'SELECT * FROM bot_requests WHERE id = ? AND dev_number = ?',
            [req.params.id, req.session.user.phoneNumber]
        );

        if (!request.length) {
            return res.status(404).json({ error: 'Bot request not found or unauthorized' });
        }

        // Delete related records first
        await connection.query('DELETE FROM bot_request_env_vars WHERE request_id = ?', [req.params.id]);

        // Delete the main request
        await connection.query('DELETE FROM bot_requests WHERE id = ?', [req.params.id]);

        await connection.commit();
        res.json({ success: true, message: 'Bot request deleted successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error deleting bot request:', error);
        res.status(500).json({ error: 'An error occurred while deleting the bot request' });
    } finally {
        connection.release();
    }
});

// Update bot request
app.put('/bot-request/:id', isLoggedIn, async (req, res) => {
    const { id } = req.params;
    const { name, repoUrl, deploymentCost, websiteUrl, envVars } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Update main request
        await connection.query(
            'UPDATE bot_requests SET name = ?, repo_url = ?, deployment_cost = ?, website_url = ? WHERE id = ? AND dev_number = ?',
            [name, repoUrl, deploymentCost, websiteUrl, id, req.session.user.phoneNumber]
        );

        // Update env vars
        await connection.query('DELETE FROM bot_request_env_vars WHERE request_id = ?', [id]);
        for (const envVar of envVars) {
            await connection.query(
                'INSERT INTO bot_request_env_vars (request_id, var_name, var_description) VALUES (?, ?, ?)',
                [id, envVar.name, envVar.description]
            );
        }

        await connection.commit();
        res.json({ success: true, message: 'Bot request updated successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error updating bot request:', error);
        res.status(500).json({ error: 'An error occurred while updating the bot request' });
    } finally {
        connection.release();
    }
});


// Get all bot requests (admin only)
app.get('/admin/bot-requests', isAdmin, isLoggedIn, async (req, res) => {
    try {
        const [requests] = await pool.query(`
            SELECT br.*, 
                   GROUP_CONCAT(CONCAT(bre.var_name, ':', bre.var_description) SEPARATOR '||') as env_vars
            FROM bot_requests br
            LEFT JOIN bot_request_env_vars bre ON br.id = bre.request_id
            GROUP BY br.id
            ORDER BY br.created_at DESC
        `);

        // Format env_vars into an array of objects
        const formattedRequests = requests.map(request => ({
            ...request,
            env_vars: request.env_vars ? request.env_vars.split('||').map(env => {
                const [name, description] = env.split(':');
                return { name, description };
            }) : []
        }));

        res.json(formattedRequests);
    } catch (error) {
        console.error('Error fetching bot requests:', error);
        res.status(500).json({ error: 'An error occurred while fetching bot requests' });
    }
});

app.post('/admin/bot-requests/:id/handle', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Get request details first
        const [request] = await pool.query(
            'SELECT * FROM bot_requests WHERE id = ?',
            [id]
        );

        if (request.length === 0) {
            throw new Error('Bot request not found');
        }

        if (status === 'approved') {
            const [envVars] = await connection.query(
                'SELECT * FROM bot_request_env_vars WHERE request_id = ?',
                [id]
            );

            // Fixed: Added website_url to the INSERT statement
            const [result] = await connection.query(
                'INSERT INTO bots (name, repo_url, deployment_cost, dev_number, website_url) VALUES (?, ?, ?, ?, ?)',
                [
                    request[0].name,
                    request[0].repo_url,
                    request[0].deployment_cost,
                    request[0].dev_number,
                    request[0].website_url  // Added this field
                ]
            );

            // Add env vars
            for (const envVar of envVars) {
                await connection.query(
                    'INSERT INTO bot_env_vars (bot_id, var_name, var_description) VALUES (?, ?, ?)',
                    [result.insertId, envVar.var_name, envVar.var_description]
                );
            }
        }

        // Update request status
        await connection.query(
            'UPDATE bot_requests SET status = ? WHERE id = ?',
            [status, id]
        );

        await connection.commit();
        res.json({
            success: true,
            message: `Bot request ${status}`,
            deploymentCost: request[0].deployment_cost
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error handling bot request:', error);
        res.status(500).json({ error: 'An error occurred while handling the bot request' });
    } finally {
        connection.release();
    }
});



// Enhanced API key management functions
async function checkApiKeyValidity(apiKey) {
    try {
        const response = await fetch('https://api.heroku.com/account', {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/vnd.heroku+json; version=3'
            },
            timeout: 10000 // 10 second timeout
        });
        
        // Check for specific error status codes
        if (response.status === 401 || response.status === 403) {
            return false; // Invalid or unauthorized key
        }
        
        return response.ok;
    } catch (error) {
        console.error('Error checking API key:', error);
        // Don't mark as invalid for network/timeout errors
        return error.name === 'TimeoutError' ? true : false;
    }
}
async function updateApiKeyStatus(apiKey, isActive, reason) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        // Get current key status
        const [keyData] = await connection.query(
            'SELECT failed_attempts, last_checked FROM heroku_api_keys WHERE api_key = ? FOR UPDATE',
            [apiKey]
        );
        
        if (keyData.length === 0) {
            await connection.rollback();
            return;
        }
        
        // Only update if status actually changed or it's been over 5 minutes
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const lastChecked = new Date(keyData[0].last_checked);
        
        if (!isActive && lastChecked > fiveMinutesAgo) {
            // Double-check key validity before disabling
            const isStillValid = await checkApiKeyValidity(apiKey);
            if (isStillValid) {
                await connection.rollback();
                return;
            }
        }
        
        await connection.query(`
            UPDATE heroku_api_keys 
            SET 
                is_active = ?,
                last_checked = CURRENT_TIMESTAMP,
                failed_attempts = IF(? = false, failed_attempts + 1, 0),
                last_error = ?
            WHERE api_key = ?
        `, [isActive, isActive, reason || null, apiKey]);
        
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        console.error('Error updating API key status:', error);
    } finally {
        connection.release();
    }
}

// Function to get a random active API key
async function getRandomApiKey() {
    const [keys] = await pool.query(`
        SELECT api_key 
        FROM heroku_api_keys 
        WHERE is_active = true 
        ORDER BY RAND() 
        LIMIT 1
    `);
    return keys.length > 0 ? keys[0].api_key : null;
}

// Function to check app availability
async function checkAppAvailability(appName, apiKey) {
    try {
        const response = await fetch(`https://api.heroku.com/apps/${appName}`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/vnd.heroku+json; version=3'
            }
        });
        return response.ok;
    } catch (error) {
        console.error(`Error checking app ${appName}:`, error);
        return false;
    }
}

// Function to get deployment details for redeployment
async function getDeploymentDetails(deploymentId) {
    const [deployment] = await pool.query(`
        SELECT 
            d.*,
            JSON_OBJECTAGG(dev.var_name, dev.var_value) as env_vars
        FROM deployed_apps d
        LEFT JOIN deployment_env_vars dev ON d.id = dev.deployment_id
        WHERE d.id = ?
        GROUP BY d.id
    `, [deploymentId]);

    return deployment[0];
}


// Modified route to get user's apps
app.get('/user-apps', isLoggedIn, async (req, res) => {
    try {
        const phoneNumber = req.session.user.phoneNumber;
        const [userRows] = await pool.query('SELECT id FROM users WHERE phone_number = ?', [phoneNumber]);
        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const [appRows] = await pool.query('SELECT app_name, deployed_at FROM deployed_apps WHERE user_id = ?', [userRows[0].id]);
        res.json(appRows);
    } catch (error) {
        console.error('Error fetching user apps:', error);
        res.status(500).json({ error: 'An error occurred while fetching user apps' });
    }
});

// // Updated bot deployment details route
// app.get('/bot-deployment/:botId', isLoggedIn, async (req, res) => {
//     const botId = req.params.botId;

//     try {
//         // Fetch bot details with a single query
//         const [rows] = await pool.query(`
//             SELECT 
//                 b.*,
//                 JSON_ARRAYAGG(
//                     JSON_OBJECT(
//                         'var_name', bev.var_name,
//                         'is_required', bev.is_required,
//                         'var_description', bev.var_description
//                     )
//                 ) as env_vars
//             FROM bots b
//             LEFT JOIN bot_env_vars bev ON b.id = bev.bot_id
//             WHERE b.id = ?
//             GROUP BY b.id
//         `, [botId]);

//         if (rows.length === 0) {
//             return res.status(404).json({ error: 'Bot not found' });
//         }

//         const bot = rows[0];
//         const envVars = JSON.parse(bot.env_vars);
//         delete bot.env_vars;

//         // Fetch user's coins
//         const [userRows] = await pool.query(
//             'SELECT coins FROM users WHERE phone_number = ?',
//             [req.session.user.phoneNumber]
//         );

//         // Check if user can afford deployment
//         const canDeploy = userRows[0].coins >= bot.deployment_cost;

//         res.json({
//             bot,
//             envVars,
//             userCoins: userRows[0].coins,
//             canDeploy
//         });

//     } catch (error) {
//         console.error('Error fetching bot deployment details:', error);
//         res.status(500).json({ error: 'Failed to fetch bot deployment details' });
//     }
// });

// Utility function to handle app deletion and logging
async function handleAppDeletion(app, user, reason) {
    try {
        await deleteApp(app.heroku_app_name);
        await pool.query('DELETE FROM deployed_apps WHERE id = ?', [app.id]);
        console.log(`Successfully deleted app ${app.heroku_app_name} for user ${user.phone_number}. Reason: ${reason}`);
        return true;
    } catch (error) {
        console.error(`Failed to delete app ${app.heroku_app_name}:`, error);
        return false;
    }
}

// Function to process single app maintenance
async function processAppMaintenance(app, user, connection) {
    try {
        // Calculate time since deployment
        const deploymentTime = new Date(app.deployed_at).getTime();
        const currentTime = new Date().getTime();
        const hoursSinceDeployment = (currentTime - deploymentTime) / (1000 * 60 * 60);

        // Skip if 24 hours haven't passed since last deduction
        if (hoursSinceDeployment < 24) {
            return;
        }

        // Get the bot's deployment cost
        const [botRows] = await connection.query(
            'SELECT deployment_cost FROM bots WHERE id = ?',
            [app.bot_id]
        );

        if (botRows.length === 0) {
            console.error(`Bot not found for app ${app.id}`);
            return;
        }

        const deploymentCost = botRows[0].deployment_cost;

        // Check if user has enough coins
        const [userRows] = await connection.query(
            'SELECT coins FROM users WHERE id = ? FOR UPDATE',
            [user.id]
        );

        if (userRows[0].coins < deploymentCost) {
            // Not enough coins, delete the app
            await handleAppDeletion(app, user, 'insufficient_coins_24h');

            // Record the deletion event
            await connection.query(
                'INSERT INTO maintenance_logs (app_id, user_id, action, reason) VALUES (?, ?, ?, ?)',
                [app.id, user.id, 'delete', 'insufficient_coins']
            );
        } else {
            // Deduct coins and update last deduction time
            await connection.query(
                'UPDATE users SET coins = coins - ? WHERE id = ?',
                [deploymentCost, user.id]
            );

            await connection.query(
                'UPDATE deployed_apps SET last_coin_deduction = CURRENT_TIMESTAMP WHERE id = ?',
                [app.id]
            );

            // Record the coin deduction
            await connection.query(
                'INSERT INTO coin_transactions (sender_phone, amount, transaction_type, app_id) VALUES (?, ?, ?, ?)',
                [user.phone_number, deploymentCost, '24h_maintenance', app.id]
            );

            console.log(`Deducted ${deploymentCost} coins from user ${user.phone_number} for app ${app.heroku_app_name}`);
        }
    } catch (error) {
        console.error(`Error processing maintenance for app ${app.id}:`, error);
        throw error;
    }
}

// Main maintenance job
async function runMaintenanceCheck() {
    if (global.isMaintenanceRunning) {
        console.log('Previous maintenance job still running, skipping...');
        return;
    }

    global.isMaintenanceRunning = true;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Get all deployed apps that need maintenance
        // (either never had coins deducted or last deduction was more than 24 hours ago)
        const [apps] = await connection.query(`
            SELECT 
                da.*,
                u.phone_number,
                u.coins,
                u.id as user_id
            FROM deployed_apps da
            JOIN users u ON da.user_id = u.id
            WHERE 
                da.last_coin_deduction IS NULL 
                OR da.last_coin_deduction < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 24 HOUR)
            ORDER BY da.deployed_at ASC
        `);

        for (const app of apps) {
            await processAppMaintenance(app, { id: app.user_id, phone_number: app.phone_number }, connection);
            // Small delay between processing apps
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        await connection.commit();
        console.log('Maintenance check completed successfully');

    } catch (error) {
        await connection.rollback();
        console.error('Error in maintenance check:', error);

        // Log to monitoring system
        await logToMonitoring({
            event: 'maintenance_check_error',
            error: error.message,
            timestamp: new Date()
        });
    } finally {
        connection.release();
        global.isMaintenanceRunning = false;
    }
}

// Run maintenance check every 15 minutes
cron.schedule('*/15 * * * *', () => {
    runMaintenanceCheck();
}, {
    timezone: 'UTC'
});

// Function to fetch bot details and env vars from database
async function getBotDetails(botId) {
    try {
        const [botRows] = await pool.query('SELECT * FROM bots WHERE id = ?', [botId]);
        if (botRows.length === 0) {
            throw new Error('Bot not found');
        }

        const [envVars] = await pool.query('SELECT * FROM bot_env_vars WHERE bot_id = ?', [botId]);
        return {
            bot: botRows[0],
            envVars: envVars
        };
    } catch (error) {
        console.error('Error fetching bot details:', error);
        throw error;
    }
}
async function getBotDetails(botId) {
    try {
        const [botRows] = await pool.query('SELECT * FROM bots WHERE id = ?', [botId]);
        if (botRows.length === 0) {
            throw new Error('Bot not found');
        }

        const [envVars] = await pool.query('SELECT * FROM bot_env_vars WHERE bot_id = ?', [botId]);
        return {
            bot: botRows[0],
            envVars: envVars
        };
    } catch (error) {
        console.error('Error fetching bot details:', error);
        throw error;
    }
}

// Function to save deployment and env vars
async function saveDeployment(userId, botId, appName, envValues) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Insert into deployed_apps
        const [deployResult] = await connection.query(
            'INSERT INTO deployed_apps (user_id, bot_id, app_name, heroku_app_name) VALUES (?, ?, ?, ?)',
            [userId, botId, appName, appName]
        );

        // Only save environment variables if they exist
        if (envValues && typeof envValues === 'object') {
            for (const [key, value] of Object.entries(envValues)) {
                if (key && value !== undefined) {
                    await connection.query(
                        'INSERT INTO deployment_env_vars (deployment_id, var_name, var_value) VALUES (?, ?, ?)',
                        [deployResult.insertId, key, value]
                    );
                }
            }
        }

        await connection.commit();
        return deployResult.insertId;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}


// Modified deployWithMultipleKeys function to handle deployment states
async function deployWithMultipleKeys(botId, envValues, userId) {
    const { bot, envVars } = await getBotDetails(botId);
    let deploymentId = null;
    let appName = null;
    let lastError = null;
    let attemptsCount = 0;
    const MAX_ATTEMPTS = 3;

    while (attemptsCount < MAX_ATTEMPTS) {
        const apiKey = await getRandomApiKey();
        if (!apiKey) {
            throw new Error('No active API keys available in database');
        }

        try {
            // Generate unique app name
            appName = `app-${Math.random().toString(36).substring(2, 10)}`;

            // Save deployment first with 'deploying' status
            deploymentId = await saveDeployment(userId, botId, appName, envValues);

            // Create Heroku app
            const createAppResponse = await fetch('https://api.heroku.com/apps', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                },
                body: JSON.stringify({ name: appName })
            });

            if (!createAppResponse.ok) {
                throw new Error(`Failed to create app: ${await createAppResponse.text()}`);
            }

            const appData = await createAppResponse.json();

            // Update deployment status to 'configuring'
            await pool.query(
                'UPDATE deployed_apps SET status = ? WHERE id = ?',
                ['configuring', deploymentId]
            );

            // Set config vars
            const configResponse = await fetch(`https://api.heroku.com/apps/${appName}/config-vars`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                },
                body: JSON.stringify(envValues)
            });

            if (!configResponse.ok) {
                throw new Error('Failed to set environment variables');
            }

            // Update deployment status to 'building'
            await pool.query(
                'UPDATE deployed_apps SET status = ? WHERE id = ?',
                ['building', deploymentId]
            );

            // Deploy from GitHub
            const buildResponse = await fetch(`https://api.heroku.com/apps/${appName}/builds`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                },
                body: JSON.stringify({
                    source_blob: {
                        url: `https://github.com/${bot.repo_url}/tarball/main`
                    }
                })
            });

            if (!buildResponse.ok) {
                throw new Error('Failed to initiate build');
            }

            // Update deployment status to 'deployed'
            await pool.query(
                'UPDATE deployed_apps SET status = ? WHERE id = ?',
                ['active', deploymentId]
            );

            // Mark API key as successful
            await pool.query(`
                UPDATE heroku_api_keys 
                SET 
                    last_used = CURRENT_TIMESTAMP,
                    failed_attempts = 0
                WHERE api_key = ?
            `, [apiKey]);

            return {
                success: true,
                appData,
                deploymentId,
                appUrl: `https://${appName}.herokuapp.com`
            };

        } catch (error) {
            console.error(`Deployment error with API key, attempt ${attemptsCount + 1}:`, error);
            
            // Update deployment status to 'failed' if we have a deploymentId
            if (deploymentId) {
                await pool.query(
                    'UPDATE deployed_apps SET status = ?, error_message = ? WHERE id = ?',
                    ['failed', error.message, deploymentId]
                );
            }

            // Clean up Heroku app if it was created
            if (appName) {
                try {
                    await fetch(`https://api.heroku.com/apps/${appName}`, {
                        method: 'DELETE',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Accept': 'application/vnd.heroku+json; version=3'
                        }
                    });
                } catch (deleteError) {
                    console.error('Error cleaning up failed deployment:', deleteError);
                }
            }

            lastError = error;
            attemptsCount++;
        }
    }

    throw new Error(`Deployment failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError.message}`);
}
// Route to get deployment details
app.get('/deployment/:id', isLoggedIn, async (req, res) => {
    try {
        const [deployment] = await pool.query(`
            SELECT 
                d.*, 
                b.name as bot_name,
                b.repo_url,
                JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'var_name', dev.var_name,
                        'var_value', dev.var_value
                    )
                ) as env_vars
            FROM deployed_apps d
            JOIN bots b ON d.bot_id = b.id
            LEFT JOIN deployment_env_vars dev ON d.id = dev.deployment_id
            WHERE d.id = ?
            GROUP BY d.id
        `, [req.params.id]);

        if (deployment.length === 0) {
            return res.status(404).json({ error: 'Deployment not found' });
        }

        res.json(deployment[0]);
    } catch (error) {
        console.error('Error fetching deployment:', error);
        res.status(500).json({ error: 'Failed to fetch deployment details' });
    }
});

// Update the select-bot route to sort by deployments
app.get('/dashboard/select-bot', isLoggedIn, async (req, res) => {
    try {
        const [bots] = await pool.query(`
            SELECT 
                b.*,
                COALESCE(b.total_deployments, 0) as deployment_count,
                CASE
                    WHEN total_deployments >= 100 THEN 'popular'
                    WHEN total_deployments >= 50 THEN 'rising'
                    ELSE 'standard'
                END as popularity_tier
            FROM bots b
            ORDER BY total_deployments DESC, name ASC
        `);
        res.render('select-bot', { bots });
    } catch (error) {
        console.error('Error fetching bots:', error);
        res.status(500).json({ error: 'An error occurred while fetching bots' });
    }
});
app.post('/deploy', isLoggedIn, checkUserCoins, async (req, res) => {
    console.log('Request Body:', req.body);
    const { botId, ...envVars } = req.body;
    const envValues = Object.keys(envVars).reduce((acc, key) => {
        const match = key.match(/^envVars\[(.+)\]$/);
        if (match) {
            acc[match[1]] = envVars[key];
        }
        return acc;
    }, {});

    if (!envValues) {
        return res.status(400).json({ error: 'Environment variables are required' });
    }
    console.log('Environment Variables:', envValues);
    
    if (!botId) {
        return res.status(400).json({ error: 'Bot ID is required' });
    }

    const connection = await pool.getConnection();
    
    try {
        await connection.beginTransaction();

        // Verify user has enough coins
        const [userRows] = await connection.query(
            'SELECT id, coins FROM users WHERE phone_number = ?', 
            [req.session.user.phoneNumber]
        );

        if (!userRows.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'User not found' });
        }

        // Fetch bot's deployment cost and developer information
        const [botRows] = await connection.query(
            'SELECT b.deployment_cost, u.phone_number as dev_phone_number ' +
            'FROM bots b ' +
            'JOIN users u ON b.developer_id = u.id ' +
            'WHERE b.id = ?', 
            [botId]
        );

        if (!botRows.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'Bot not found' });
        }

        const deploymentCost = botRows[0].deployment_cost;
        const devNumber = botRows[0].dev_phone_number;
        const devShare = Math.floor(deploymentCost * 0.5); // 50% share for developer

        if (userRows[0].coins < deploymentCost) {
            await connection.rollback();
            return res.status(400).json({ 
                error: `Insufficient coins (${deploymentCost} coins required)` 
            });
        }

        // Deploy the bot
        const result = await deployWithMultipleKeys(botId, envValues, userRows[0].id);

        if (result.success) {
            // Deduct coins from user
            await connection.query(
                'UPDATE users SET coins = coins - ? WHERE id = ?',
                [deploymentCost, userRows[0].id]
            );

            // Add developer share
            await connection.query(
                'UPDATE users SET coins = coins + ? WHERE phone_number = ?',
                [devShare, devNumber]
            );

            // Record deployment transaction
            await connection.query(
                'INSERT INTO coin_transactions (sender_phone, amount, transaction_type) VALUES (?, ?, ?)',
                [req.session.user.phoneNumber, deploymentCost, 'deployment']
            );

            // Record developer share transaction
            await connection.query(
                'INSERT INTO coin_transactions (sender_phone, receiver_phone, amount, transaction_type) VALUES (?, ?, ?, ?)',
                [req.session.user.phoneNumber, devNumber, devShare, 'dev_share']
            );

            await connection.commit();

            res.json({
                success: true,
                message: 'Bot deployed successfully',
                appUrl: `https://${result.appData.name}.herokuapp.com`,
                deploymentId: result.deploymentId,
                deploymentCost: deploymentCost,
                devShare: devShare
            });
        } else {
            await connection.rollback();
            res.status(500).json({ error: 'Deployment failed', details: result.message });
        }
    } catch (error) {
        await connection.rollback();
        console.error('Deployment error:', error);
        res.status(500).json({ 
            error: 'Deployment failed', 
            message: error.message,
            details: error.stack 
        });
    } finally {
        connection.release();
    }
});
app.post('/dashboard/select-bot/prepare-deployment', async (req, res) => {
    try {
        const botId = req.body.botId;

        // Fetch bot details including website_url
        const [botRows] = await pool.query(
            'SELECT * FROM bots WHERE id = ?',
            [botId]
        );

        if (botRows.length === 0) {
            return res.status(404).send('Bot not found');
        }

        const bot = botRows[0];

        // Fetch environment variables for the selected bot
        const [envVarRows] = await pool.query(
            'SELECT * FROM bot_env_vars WHERE bot_id = ?',
            [botId]
        );

        bot.envVars = envVarRows;

        res.render('deploy-bot', { bot });
    } catch (error) {
        console.error('Error preparing deployment:', error);
        res.status(500).send('An error occurred while preparing the deployment');
    }
});

// Get all API keys
app.get('/admin/api-keys', isAdmin, async (req, res) => {
    try {
        const [keys] = await pool.query(`
            SELECT 
                id,
                api_key,
                is_active,
                last_checked,
                failed_attempts,
                last_used,
                created_at
            FROM heroku_api_keys
            ORDER BY created_at DESC
        `);

        // Mask API keys for security
        const maskedKeys = keys.map(key => ({
            ...key,
            api_key: `${key.api_key.substring(0, 8)}...${key.api_key.substring(key.api_key.length - 8)}`
        }));

        res.json(maskedKeys);
    } catch (error) {
        console.error('Error fetching API keys:', error);
        res.status(500).json({ error: 'Failed to fetch API keys' });
    }
});

// Add new API key
app.post('/admin/api-keys', isAdmin, async (req, res) => {
    try {
        const { apiKey } = req.body;

        // Validate API key
        const isValid = await checkApiKeyValidity(apiKey);

        if (!isValid) {
            return res.status(400).json({ error: 'Invalid API key' });
        }

        // Check if key already exists
        const [existing] = await pool.query(
            'SELECT id FROM heroku_api_keys WHERE api_key = ?',
            [apiKey]
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: 'API key already exists' });
        }

        // Insert new key
        await pool.query(`
            INSERT INTO heroku_api_keys (api_key, is_active)
            VALUES (?, true)
        `, [apiKey]);

        res.json({ success: true, message: 'API key added successfully' });
    } catch (error) {
        console.error('Error adding API key:', error);
        res.status(500).json({ error: 'Failed to add API key' });
    }
});

// Update API key status
app.put('/admin/api-keys/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { is_active } = req.body;

        await pool.query(`
            UPDATE heroku_api_keys
            SET 
                is_active = ?,
                last_checked = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [is_active, id]);

        res.json({ success: true, message: 'API key updated successfully' });
    } catch (error) {
        console.error('Error updating API key:', error);
        res.status(500).json({ error: 'Failed to update API key' });
    }
});

// Delete API key
app.delete('/admin/api-keys/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        await pool.query('DELETE FROM heroku_api_keys WHERE id = ?', [id]);

        res.json({ success: true, message: 'API key deleted successfully' });
    } catch (error) {
        console.error('Error deleting API key:', error);
        res.status(500).json({ error: 'Failed to delete API key' });
    }
});

// Admin dashboard view
app.get('/admin/api-keys/view', isAdmin, async (req, res) => {
    try {
        const [keys] = await pool.query(`
            SELECT 
                id,
                CONCAT(LEFT(api_key, 8), '...', RIGHT(api_key, 8)) as masked_key,
                is_active,
                last_checked,
                failed_attempts,
                last_used,
                created_at
            FROM heroku_api_keys
            ORDER BY created_at DESC
        `);

        res.render('admin/api-keys', { keys });
    } catch (error) {
        console.error('Error loading API keys view:', error);
        res.status(500).send('Error loading API keys');
    }
});

// Scheduled task to check API keys
setInterval(async () => {
    try {
        const [keys] = await pool.query('SELECT api_key FROM heroku_api_keys');
        for (const { api_key } of keys) {
            const isValid = await checkApiKeyValidity(api_key);
            await updateApiKeyStatus(api_key, isValid);
        }
    } catch (error) {
        console.error('Error in API key check routine:', error);
    }
}, 60 * 60 * 1000); // Every hour

// Scheduled task to check app availability and redeploy if necessary
setInterval(async () => {
    try {
        const [deployments] = await pool.query(`
            SELECT 
                dh.id as history_id,
                dh.deployment_id,
                dh.app_name,
                dh.redeployment_count
            FROM deployment_history dh
            WHERE dh.status = 'active'
            AND dh.last_checked <= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        `);

        for (const deployment of deployments) {
            const apiKey = await getRandomApiKey();
            if (!apiKey) continue;

            const isAvailable = await checkAppAvailability(deployment.app_name, apiKey);

            if (!isAvailable) {
                console.log(`App ${deployment.app_name} is down, initiating redeployment...`);

                // Get original deployment details
                const deploymentDetails = await getDeploymentDetails(deployment.deployment_id);

                // Attempt redeployment
                try {
                    const result = await deployWithMultipleKeys(
                        deploymentDetails.bot_id,
                        JSON.parse(deploymentDetails.env_vars),
                        deploymentDetails.user_id
                    );

                    if (result.success) {
                        await pool.query(`
                            UPDATE deployment_history 
                            SET 
                                status = 'inactive',
                                last_checked = CURRENT_TIMESTAMP
                            WHERE id = ?
                        `, [deployment.history_id]);

                        await pool.query(`
                            INSERT INTO deployment_history 
                                (deployment_id, app_name, status, redeployment_count)
                            VALUES (?, ?, 'active', ?)
                        `, [
                            deployment.deployment_id,
                            result.appData.name,
                            deployment.redeployment_count + 1
                        ]);
                    }
                } catch (error) {
                    console.error('Redeployment failed:', error);
                }
            } else {
                await pool.query(`
                    UPDATE deployment_history 
                    SET last_checked = CURRENT_TIMESTAMP
                    WHERE id = ?
                `, [deployment.history_id]);
            }
        }
    } catch (error) {
        console.error('Error in app monitoring routine:', error);
    }
}, 10 * 60 * 1000); // Every 10 minutes
///////////////////////////////////////////
/// Another

// Admin route to add new Heroku account
app.post('/admin/heroku-accounts', isAdmin, async (req, res) => {
    const { email, password, recoveryCodes } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO heroku_accounts (email, password, recovery_codes) VALUES (?, ?, ?)',
            [email, password, recoveryCodes]
        );
        res.json({ message: 'Heroku account added successfully', id: result.insertId });
    } catch (error) {
        console.error('Error adding Heroku account:', error);
        res.status(500).json({ error: 'An error occurred while adding the Heroku account' });
    }
});

// Admin route to view all Heroku accounts
app.get('/admin/heroku-accounts', isAdmin, async (req, res) => {
    try {
        const [accounts] = await pool.query('SELECT * FROM heroku_accounts');
        res.json(accounts);
    } catch (error) {
        console.error('Error fetching Heroku accounts:', error);
        res.status(500).json({ error: 'An error occurred while fetching Heroku accounts' });
    }
});

// User route to buy Heroku account
app.post('/buy-heroku-account', isLoggedIn, async (req, res) => {
    const userId = req.session.user.id;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // Check user's coins
        const [userRows] = await connection.query(
            'SELECT coins FROM users WHERE id = ? FOR UPDATE',
            [userId]
        );

        if (userRows.length === 0 || userRows[0].coins < 500) {
            throw new Error('Insufficient coins');
        }

        // Get available account
        const [accountRows] = await connection.query(
            'SELECT id FROM heroku_accounts WHERE is_sold = FALSE LIMIT 1 FOR UPDATE'
        );

        if (accountRows.length === 0) {
            throw new Error('No accounts available');
        }

        const accountId = accountRows[0].id;

        // Update user's coins
        await connection.query(
            'UPDATE users SET coins = coins - 500 WHERE id = ?',
            [userId]
        );

        // Mark account as sold
        await connection.query(
            'UPDATE heroku_accounts SET is_sold = TRUE WHERE id = ?',
            [accountId]
        );

        // Record purchase
        await connection.query(
            'INSERT INTO purchased_heroku_accounts (user_id, account_id) VALUES (?, ?)',
            [userId, accountId]
        );

        await connection.commit();
        res.json({ message: 'Heroku account purchased successfully' });
    } catch (error) {
        await connection.rollback();
        console.error('Error purchasing Heroku account:', error);
        res.status(500).json({ error: error.message });
    } finally {
        connection.release();
    }
});

// User route to view purchased accounts
app.get('/my-heroku', isLoggedIn, async (req, res) => {
    try {
        const [accounts] = await pool.query(
            `SELECT ha.email, ha.password, ha.recovery_codes, pha.purchased_at 
             FROM purchased_heroku_accounts pha 
             JOIN heroku_accounts ha ON pha.account_id = ha.id 
             WHERE pha.user_id = ?`,
            [req.session.user.id]
        );
        res.json(accounts);
    } catch (error) {
        console.error('Error fetching purchased accounts:', error);
        res.status(500).json({ error: 'An error occurred while fetching your accounts' });
    }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    // Add path verification
    verifyClient: (info) => {
        const path = info.req.url;
        return path.startsWith('/api/logs/') && path.includes('/stream');
    }
});

// Keep track of active connections
const activeConnections = new Map();

// WebSocket connection handler
wss.on('connection', async (ws, req) => {
    // Extract app name from URL with proper error handling
    let appName;
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        appName = url.pathname.split('/').filter(Boolean)[2]; // ['api', 'logs', 'appName', 'stream']

        if (!appName) {
            throw new Error('Invalid app name');
        }
    } catch (error) {
        console.error('Invalid WebSocket URL:', error);
        ws.close(1003, 'Invalid app name');
        return;
    }

    // Add connection to active connections with timeout handling
    const connectionId = Date.now().toString();
    let logSession = null;
    let logWs = null;

    const connection = {
        ws,
        logWs: null,
        timer: setTimeout(() => {
            cleanup('Connection timeout');
        }, 30000) // 30 second timeout
    };

    activeConnections.set(connectionId, connection);

    // Cleanup function with reason
    const cleanup = (reason = 'Normal closure') => {
        clearTimeout(connection.timer);
        if (logWs) {
            logWs.close(1000, reason);
        }
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, reason);
        }
        activeConnections.delete(connectionId);
        console.log(`Cleaned up connection ${connectionId}: ${reason}`);
    };

    // Send initial connection status
    try {
        ws.send(JSON.stringify({ type: 'status', message: 'Connecting to log stream...' }));
    } catch (error) {
        cleanup('Failed to send initial status');
        return;
    }

    // Handle ping/pong for connection health check
    ws.on('ping', () => {
        try {
            ws.pong();
        } catch (error) {
            console.error('Error sending pong:', error);
        }
    });

    let pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.ping();
            } catch (error) {
                console.error('Error sending ping:', error);
                cleanup('Ping failed');
            }
        }
    }, 30000);

    try {
        // Get database connection from pool with timeout
        const connection = await Promise.race([
            pool.getConnection(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Database connection timeout')), 5000)
            )
        ]);

        // Fetch active API keys
        const [apiKeys] = await connection.query(
            'SELECT api_key FROM heroku_api_keys WHERE is_active = true'
        );
        connection.release();

        if (!apiKeys.length) {
            throw new Error('No active API keys found');
        }

        // Try each API key until successful
        let sessionCreated = false;
        for (const { api_key } of apiKeys) {
            try {
                logSession = await axios.post(
                    `https://api.heroku.com/apps/${appName}/log-sessions`,
                    { tail: true },
                    {
                        headers: {
                            'Authorization': `Bearer ${api_key}`,
                            'Accept': 'application/vnd.heroku+json; version=3'
                        },
                        timeout: 5000 // 5 second timeout for API requests
                    }
                );
                sessionCreated = true;
                break;
            } catch (error) {
                console.error(`Failed to create log session with API key: ${error.message}`);
                continue;
            }
        }

        if (!sessionCreated || !logSession?.data?.logplex_url) {
            throw new Error('Failed to create log session');
        }

        // Connect to Heroku's log stream
        logWs = new WebSocket(logSession.data.logplex_url);
        connection.logWs = logWs;

        // Handle log stream connection
        logWs.on('open', () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'status', message: 'Connected to log stream' }));
            }
        });

        logWs.on('message', (data) => {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    const logLine = data.toString();
                    const processed = processLogLine(logLine);
                    ws.send(JSON.stringify({ type: 'log', data: processed }));
                } catch (error) {
                    console.error('Error processing log line:', error);
                }
            }
        });

        logWs.on('error', (error) => {
            console.error('Heroku log stream error:', error);
            cleanup('Log stream error');
        });

        logWs.on('close', () => {
            cleanup('Log stream closed');
        });

        // Handle client WebSocket events
        ws.on('error', (error) => {
            console.error('Client WebSocket error:', error);
            cleanup('Client error');
        });

        ws.on('close', () => {
            cleanup('Client closed connection');
        });

    } catch (error) {
        console.error('Error in WebSocket connection:', error);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: `Connection error: ${error.message}`
            }));
        }
        cleanup('Setup error');
    }

    // Cleanup on server shutdown
    process.on('SIGTERM', () => {
        cleanup('Server shutting down');
    });
});
// Your existing Express routes
app.get('/api/logs/:appName', async (req, res) => {
    const appName = req.params.appName;
    const { lines = 100, source, dyno } = req.query;
    let connection;

    try {
        connection = await pool.getConnection();

        // Fetch active API keys from database
        const [apiKeys] = await connection.query(
            'SELECT api_key FROM heroku_api_keys WHERE is_active = true'
        );

        let logs = null;
        let lastError = null;

        for (const { api_key } of apiKeys) {
            try {
                const queryParams = new URLSearchParams({
                    lines: lines.toString(),
                    ...(source && { source }),
                    ...(dyno && { dyno })
                });

                const sessionResponse = await axios.post(
                    `https://api.heroku.com/apps/${appName}/log-sessions`,
                    {
                        lines,
                        source,
                        dyno,
                        tail: false
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${api_key}`,
                            'Accept': 'application/vnd.heroku+json; version=3',
                            'Content-Type': 'application/json'
                        }
                    }
                );

                if (sessionResponse.data && sessionResponse.data.logplex_url) {
                    const logsResponse = await axios.get(sessionResponse.data.logplex_url);
                    logs = logsResponse.data;
                    break;
                }
            } catch (error) {
                lastError = error;
                continue;
            }
        }

        if (logs) {
            const processedLogs = logs
                .split('\n')
                .filter(line => line.trim())
                .map(line => processLogLine(line));

            res.json({
                success: true,
                appName,
                logs: processedLogs
            });
        } else {
            throw lastError || new Error('Failed to fetch logs');
        }
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({
            success: false,
            error: `Failed to fetch logs: ${error.message}`
        });
    } finally {
        if (connection) {
            try {
                connection.release();
            } catch (releaseError) {
                console.error('Error releasing connection:', releaseError);
            }
        }
    }
});
// Updated processLogLine function with better error handling
function processLogLine(line) {
    try {
        if (!line || typeof line !== 'string') {
            return { type: 'raw', message: String(line) };
        }

        const matches = line.match(/^([\d-]+T[\d:.]+Z) (\w+)\[(\w+)\]: (.+)$/);
        if (matches) {
            return {
                type: 'structured',
                timestamp: matches[1],
                source: matches[2],
                dyno: matches[3],
                message: matches[4]
            };
        }
        return { type: 'raw', message: line };
    } catch (e) {
        console.error('Error processing log line:', e);
        return { type: 'raw', message: String(line) };
    }
}

// Cleanup interval to remove stale connections
setInterval(() => {
    for (const [id, connection] of activeConnections) {
        if (connection.ws.readyState === WebSocket.CLOSED) {
            activeConnections.delete(id);
        }
    }
}, 60000);
// Start the server
app.listen(PORT, () => console.log(`Server running on PORT ${PORT}`));
// Cleanup handlers
async function cleanup() {
    console.log('Cleaning up...');
    await closeWAConnection();
    await pool.end();
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);