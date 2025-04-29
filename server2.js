const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cors = require('cors');
const ping = require('ping');
const { Parser } = require('json2csv');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(bodyParser.json());
app.use(cors());
app.set('view engine', 'ejs');

// Connect to MongoDB
mongoose.connect('mongodb://localhost/ipMonitor_v1', { useNewUrlParser: true, useUnifiedTopology: true });

const ipSchema = new mongoose.Schema({
    address: String,
    status: String,
    downtime: [{ timestamp: Date }],
    uptime: [{ timestamp: Date }]
});

const IP = mongoose.model('IP', ipSchema);

// Middleware to disable caching
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

// Serve the frontend
app.use(express.static('public'));

// API to add a new IP address
app.post('/api/ip', async (req, res) => {
    const { address } = req.body;
    const newIP = new IP({ address, status: 'Unknown', downtime: [] });
    await newIP.save();
    res.send(newIP);
});

// API to get all IP addresses and their statuses
app.get('/api/ip', async (req, res) => {
    const ips = await IP.find();
    const ipsWithDowntimeInfo = ips.map(ip => {
        const downtimeCount = ip.downtime.length;
        const lastDowntime = downtimeCount > 0 ? ip.downtime[downtimeCount - 1].timestamp : null;
        return {
            ...ip.toObject(),
            downtimeCount,
            lastDowntime
        };
    });
    res.send(ipsWithDowntimeInfo);
});

// API to download downtime history as CSV
app.get('/api/download', async (req, res) => {
    const ips = await IP.find();
    const data = ips.map(ip => {
        return ip.downtime.map(d => ({
            address: ip.address,
            timestamp: new Date(d.timestamp).toLocaleString() // Convert timestamp to local string
        }));
    }).flat();
    
    const fields = ['address', 'timestamp'];
    const opts = { fields };
    try {
        const parser = new Parser(opts);
        const csv = parser.parse(data);
        
        const filePath = path.join(__dirname, 'downtime_history.csv');
        fs.writeFileSync(filePath, csv);

        res.download(filePath, 'downtime_history.csv', (err) => {
            if (err) {
                console.error('Error downloading the file:', err);
                res.status(500).send('Error downloading the file');
            }
            fs.unlinkSync(filePath); // delete the file after sending
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating the CSV');
    }
});

// Constantly ping IP addresses
setInterval(async () => {
    const ips = await IP.find();
    for (const ip of ips) {
        const res = await ping.promise.probe(ip.address);
        if (!res.alive && ip.status !== 'Down') {
            ip.status = 'Down';
            ip.downtime.push({ timestamp: new Date() });
        } else if (res.alive && ip.status !== 'Up') {
            ip.status = 'Up';
            ip.uptime.push({ timestamp: new Date() });
        }
        await ip.save();
    }
}, 10000); // Ping every 10 seconds

app.get('/', (req, res) => {
    res.render('index');
});

app.listen(9990, () => {
    console.log('Server is running on http://localhost:9990');
});
