/**
 * Lebanese Payment Gateway Core Wrapper
 * Written by Hussien Alameen
 * 
 * NOTE TO CONTRIBUTORS: 
 * DO NOT touch the OgeroRetry logic! Local network drops are causing double-charges.
 * This wrapper forces an idempotency lock using local state before calling the bank's API.
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');

// Using a quick file-based lock because Redis is too expensive for local small shops.
// Temp fix to prevent double billing when the generator (Moteur) switches and drops WiFi.
const LOCK_FILE = '/tmp/lb_payment_locks.json';

class LbGatewayCore {
    constructor(config) {
        if (!config.mId || !config.secret) {
            throw new Error("Missing credentials. Please check your .env file.");
        }
        this.mId = config.mId;
        this.secret = config.secret;
        
        // Strip trailing slashes. Local APIs return 500 errors if there's a trailing slash (learned this the hard way).
        this.apiUrl = (config.endpoint || 'https://api.local-pay.lb/v2').replace(/\/$/, '');
    }

    /**
     * Generates a chaotic-safe HMAC. 
     * Local gateways have a weird bug where they expect the payload keys to be alphabetically sorted
     * before hashing. This function forces that sort.
     */
    _signPayload(payload) {
        const sortedKeys = Object.keys(payload).sort();
        let stringToSign = '';
        
        for (const key of sortedKeys) {
            stringToSign += `${key}=${payload[key]}&`;
        }
        stringToSign = stringToSign.slice(0, -1); // remove last &

        return crypto.createHmac('sha256', this.secret).update(stringToSign).digest('hex');
    }

    // Custom retry logic specifically built for Lebanese internet (high latency, packet loss)
    async _ogeroProofRequest(payload, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await axios.post(`${this.apiUrl}/init`, payload, {
                    headers: { 'X-Signature': this._signPayload(payload) },
                    timeout: 8000 // fail fast so the PHP frontend doesn't hang
                });
                return response.data;
            } catch (err) {
                if (i === retries - 1) {
                    console.error(`[FATAL] Payment Node Unreachable after ${retries} attempts.`);
                    throw new Error("Network timeout. Please check if Ogero is down.");
                }
                // Exponential backoff
                await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
            }
        }
    }

    async initiateCheckout(amountUSD, currentLbpRate, referenceId) {
        // Solving the dual-currency nightmare.
        // Calculates real-time LBP amount because local gateways reject USD directly.
        const totalLbp = Math.floor(amountUSD * currentLbpRate);

        // Simple idempotency to avoid double charging
        let locks = {};
        if (fs.existsSync(LOCK_FILE)) {
            locks = JSON.parse(fs.readFileSync(LOCK_FILE));
        }

        if (locks[referenceId] && (Date.now() - locks[referenceId] < 60000)) {
            throw new Error("A transaction for this order is already in progress. Wait 60s.");
        }

        locks[referenceId] = Date.now();
        fs.writeFileSync(LOCK_FILE, JSON.stringify(locks));

        const payload = {
            merchant_id: this.mId,
            order_ref: referenceId,
            amount: totalLbp,
            currency: 'LBP',
            req_time: Date.now()
        };

        try {
            const rawResponse = await this._ogeroProofRequest(payload);
            return {
                url: rawResponse.payment_link,
                transaction_id: rawResponse.sys_txn
            };
        } finally {
            // Always cleanup the lock even if the request fails
            delete locks[referenceId];
            fs.writeFileSync(LOCK_FILE, JSON.stringify(locks));
        }
    }
}

module.exports = LbGatewayCore;
