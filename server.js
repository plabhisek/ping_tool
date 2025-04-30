const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cors = require('cors');
const ping = require('ping');
const { Parser } = require('json2csv');
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const csv = require('csv-parser');

const app = express();

app.use(bodyParser.json());
app.use(cors());
app.set('view engine', 'ejs');

// Connect to MongoDB with indexing options
mongoose.connect('mongodb://localhost/ipMonitor', { 
    useNewUrlParser: true, 
    useUnifiedTopology: true 
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
    console.log('Connected to MongoDB');
    // Create indexes for better query performance
    IP.collection.createIndex({ address: 1 });
    IP.collection.createIndex({ status: 1 });
    IP.collection.createIndex({ lastChecked: 1 });
});

// Optimized Schema: Separate downtime collection to reduce document size
const ipSchema = new mongoose.Schema({
    address: { type: String, required: true, unique: true },
    location: { type: String, default: '' },
    status: { type: String, default: 'Unknown' },
    downtimeCount: { type: Number, default: 0 },
    lastDowntime: { type: Date, default: null },
    lastChecked: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

const downtimeSchema = new mongoose.Schema({
    ipAddress: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    duration: { type: Number, default: null } // in milliseconds
}, { 
    timeseries: {
        timeField: 'timestamp',
        metaField: 'ipAddress',
        granularity: 'seconds'
    }
});

const IP = mongoose.model('IP', ipSchema);
const Downtime = mongoose.model('Downtime', downtimeSchema);

// Middleware to disable caching
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

// Serve the frontend
app.use(express.static('public'));

// API to add a new IP address
app.post('/api/ip', async (req, res) => {
    try {
        const { address, location = '' } = req.body;
        
        // Check if IP already exists
        const existingIP = await IP.findOne({ address });
        if (existingIP) {
            return res.status(400).send({ error: 'IP address already exists' });
        }
        
        const newIP = new IP({ 
            address, 
            location, 
            status: 'Unknown', 
            downtimeCount: 0,
            lastChecked: new Date()
        });
        
        await newIP.save();
        res.status(201).send(newIP);
    } catch (error) {
        console.error('Error adding IP:', error);
        res.status(500).send({ error: 'Failed to add IP address' });
    }
});
// API to download a template CSV file for mass upload
app.get('/api/template', (req, res) => {
    try {
        const csvData = "address,location\n8.8.8.8,Google DNS\n1.1.1.1,Cloudflare DNS";
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=ip_template.csv');
        
        res.send(csvData);
    } catch (error) {
        console.error('Error generating template:', error);
        res.status(500).send({ error: 'Failed to generate template' });
    }
});

// API to handle mass upload of IP addresses
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send({ error: 'No file uploaded' });
        }
        
        const results = [];
        const errors = [];
        const existingIPs = new Set();
        
        // Get existing IPs to avoid duplicates
        const ips = await IP.find({}, 'address');
        ips.forEach(ip => existingIPs.add(ip.address));
        
        // Parse the CSV file
        await new Promise((resolve, reject) => {
            fs.createReadStream(req.file.path)
                .pipe(csv())
                .on('data', (data) => {
                    // Validate data has required fields
                    if (!data.address) {
                        errors.push(`Row missing IP address: ${JSON.stringify(data)}`);
                        return;
                    }
                    
                    // Check if IP already exists
                    if (existingIPs.has(data.address)) {
                        errors.push(`IP already exists: ${data.address}`);
                        return;
                    }
                    
                    // Add to results for batch processing
                    results.push({
                        address: data.address,
                        location: data.location || '',
                        status: 'Unknown',
                        downtimeCount: 0,
                        lastChecked: new Date()
                    });
                    
                    // Add to existing set to prevent duplicates within the file
                    existingIPs.add(data.address);
                })
                .on('end', resolve)
                .on('error', reject);
        });
        
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        
        // If we have valid results, insert them
        if (results.length > 0) {
            await IP.insertMany(results);
        }
        
        res.status(200).send({
            success: true,
            added: results.length,
            errors: errors
        });
    } catch (error) {
        console.error('Error processing upload:', error);
        
        // Clean up the file if it exists
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        res.status(500).send({ error: 'Failed to process uploaded file' });
    }
});
// API to get all IP addresses and their statuses with filtering
app.get('/api/ip', async (req, res) => {
    try {
        const { status, location, search } = req.query;
        const query = {};
        
        // Apply filters if provided
        if (status && status !== 'All') {
            query.status = status;
        }
        
        if (location && location !== 'All') {
            query.location = location;
        }
        
        if (search) {
            query.address = { $regex: search, $options: 'i' };
        }
        
        const ips = await IP.find(query).sort({ address: 1 });
        res.send(ips);
    } catch (error) {
        console.error('Error fetching IPs:', error);
        res.status(500).send({ error: 'Failed to fetch IP addresses' });
    }
});

// API to get available locations for filtering
app.get('/api/locations', async (req, res) => {
    try {
        const locations = await IP.distinct('location');
        res.send(locations);
    } catch (error) {
        console.error('Error fetching locations:', error);
        res.status(500).send({ error: 'Failed to fetch locations' });
    }
});

// API to download downtime history as CSV with filtering
app.get('/api/download', async (req, res) => {
    try {
        const { startDate, endDate, ipAddress } = req.query;
        const query = {};
        
        if (ipAddress && ipAddress !== 'All') {
            query.ipAddress = ipAddress;
        }
        
        if (startDate && endDate) {
            query.timestamp = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        } else if (startDate) {
            query.timestamp = { $gte: new Date(startDate) };
        } else if (endDate) {
            query.timestamp = { $lte: new Date(endDate) };
        }
        
        // Use lean() for better performance when fetching data
        const downtimes = await Downtime.find(query)
            .sort({ timestamp: -1 })
            .lean();
        
        const data = downtimes.map(d => ({
            address: d.ipAddress,
            timestamp: new Date(d.timestamp).toLocaleString(),
            duration: d.duration ? `${Math.round(d.duration / 1000)} seconds` : 'N/A'
        }));
        
        const fields = ['address', 'timestamp', 'duration'];
        const opts = { fields };
        
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
    } catch (error) {
        console.error('Error generating CSV:', error);
        res.status(500).send({ error: 'Failed to generate CSV' });
    }
});

// API to get downtime history for a specific IP
app.get('/api/downtime/:ipAddress', async (req, res) => {
    try {
        const { ipAddress } = req.params;
        const { limit = 10 } = req.query;
        
        const downtimes = await Downtime.find({ ipAddress })
            .sort({ timestamp: -1 })
            .limit(parseInt(limit))
            .lean();
            
        res.send(downtimes);
    } catch (error) {
        console.error('Error fetching downtime history:', error);
        res.status(500).send({ error: 'Failed to fetch downtime history' });
    }
});

// Delete an IP address
app.delete('/api/ip/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const ip = await IP.findById(id);
        
        if (!ip) {
            return res.status(404).send({ error: 'IP not found' });
        }
        
        // Delete the IP and its downtime records
        await IP.findByIdAndDelete(id);
        await Downtime.deleteMany({ ipAddress: ip.address });
        
        res.send({ message: 'IP deleted successfully' });
    } catch (error) {
        console.error('Error deleting IP:', error);
        res.status(500).send({ error: 'Failed to delete IP' });
    }
});

// Worker thread ping function
function pingInWorker(ipAddresses) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: { ipAddresses }
        });
        
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });
    });
}

// Worker thread implementation
if (!isMainThread) {
    const { ipAddresses } = workerData;
    
    const pingPromises = ipAddresses.map(async (ip) => {
        try {
            const res = await ping.promise.probe(ip);
            return {
                address: ip,
                alive: res.alive,
                time: res.time
            };
        } catch (error) {
            return {
                address: ip,
                alive: false,
                time: null
            };
        }
    });
    
    Promise.all(pingPromises)
        .then(results => {
            parentPort.postMessage(results);
        });
} else {
    // Ping management - using worker threads
    async function runPingCycle() {
        try {
            // Get all IPs from DB
            const ips = await IP.find({});
            
            if (ips.length === 0) {
                setTimeout(runPingCycle, 5000);
                return;
            }
            
            // Divide IPs into chunks based on CPU cores
            const cpuCount = os.cpus().length;
            const batchSize = Math.max(1, Math.ceil(ips.length / cpuCount));
            const batches = [];
            
            for (let i = 0; i < ips.length; i += batchSize) {
                batches.push(ips.slice(i, i + batchSize).map(ip => ip.address));
            }
            
            // Process each batch with a worker thread
            const batchResults = await Promise.all(
                batches.map(batch => pingInWorker(batch))
            );
            
            // Flatten results
            const results = batchResults.flat();
            
            // Update DB with results
            const bulkOps = [];
            const now = new Date();
            
            for (const result of results) {
                const ip = ips.find(ip => ip.address === result.address);
                
                if (!ip) continue;
                
                const wasDown = ip.status === 'Down';
                const isDown = !result.alive;
                
                // Handle status change: Up -> Down
                if (!wasDown && isDown) {
                    // Add to downtime collection
                    const newDowntime = new Downtime({
                        ipAddress: ip.address,
                        timestamp: now
                    });
                    await newDowntime.save();
                    
                    // Update IP status
                    await IP.updateOne(
                        { _id: ip._id },
                        { 
                            status: 'Down',
                            lastDowntime: now,
                            lastChecked: now,
                            $inc: { downtimeCount: 1 }
                        }
                    );
                } 
                // Handle status change: Down -> Up
                else if (wasDown && !isDown) {
                    // Update the duration of the last downtime record
                    const lastDowntime = await Downtime.findOne({ 
                        ipAddress: ip.address 
                    }).sort({ timestamp: -1 });
                    
                    if (lastDowntime && !lastDowntime.duration) {
                        lastDowntime.duration = now - lastDowntime.timestamp;
                        await lastDowntime.save();
                    }
                    
                    // Update IP status
                    await IP.updateOne(
                        { _id: ip._id },
                        { 
                            status: 'Up',
                            lastChecked: now
                        }
                    );
                }
                // No status change, just update lastChecked
                else {
                    await IP.updateOne(
                        { _id: ip._id },
                        { lastChecked: now }
                    );
                }
            }
            
            // Schedule next ping cycle
            setTimeout(runPingCycle, 5000);
        } catch (error) {
            console.error('Error in ping cycle:', error);
            // Continue the cycle even if there's an error
            setTimeout(runPingCycle, 5000);
        }
    }

    // Start the ping cycle
    runPingCycle();

    app.get('/', (req, res) => {
        res.render('index');
    });

    // Start the server
    const PORT = process.env.PORT || 9990;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}