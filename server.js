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
// Improve MongoDB schema and indexes
// Replace the MongoDB connection and schema section

// Connect to MongoDB with better options
mongoose.connect('mongodb://localhost/ipMonitor', { 
    useNewUrlParser: true, 
    useUnifiedTopology: true,
    // Add connection pool options
    poolSize: 10,
    socketTimeoutMS: 45000,
    // Improve write concern for better performance
    w: 1,
    wtimeout: 2500
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', async () => {
    console.log('Connected to MongoDB');
    
    try {
        // Create more efficient compound indexes
        await IP.collection.createIndex({ status: 1, lastChecked: -1 });
        await IP.collection.createIndex({ address: 1 }, { unique: true });
        await IP.collection.createIndex({ location: 1 });
        
        // Index for downtime history queries
        await Downtime.collection.createIndex({ ipAddress: 1, timestamp: -1 });
        
        console.log('Database indexes created successfully');
    } catch (error) {
        console.error('Error creating database indexes:', error);
    }
});

// Optimize IP Schema with better field types and validation
const ipSchema = new mongoose.Schema({
    address: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true
    },
    location: { 
        type: String, 
        default: '',
        trim: true,
        index: true
    },
    status: { 
        type: String, 
        default: 'Unknown',
        enum: ['Up', 'Down', 'Unknown'],
        index: true
    },
    downtimeCount: { 
        type: Number, 
        default: 0,
        min: 0
    },
    lastDowntime: { 
        type: Date, 
        default: null 
    },
    lastChecked: { 
        type: Date, 
        default: Date.now,
        index: true 
    },
    createdAt: { 
        type: Date, 
        default: Date.now,
        immutable: true 
    }
}, {
    // Add timestamp fields (updatedAt)
    timestamps: true,
    // Use this for better memory usage
    versionKey: false
});

// Optimize downtime schema for better performance
const downtimeSchema = new mongoose.Schema({
    ipAddress: { 
        type: String, 
        required: true,
        index: true
    },
    timestamp: { 
        type: Date, 
        default: Date.now,
        index: true
    },
    duration: { 
        type: Number, 
        default: null,
        min: 0
    }
}, { 
    timeseries: {
        timeField: 'timestamp',
        metaField: 'ipAddress',
        granularity: 'seconds'
    },
    // Use this for better memory usage
    versionKey: false
});

// Add methods to the schemas for better code organization
ipSchema.methods.getDowntimeHistory = async function(limit = 10) {
    return await Downtime.find({ ipAddress: this.address })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();
};

// Static methods for batch operations
ipSchema.statics.getStatusCounts = async function() {
    return await this.aggregate([
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }
    ]);
};

// Efficient downtime count method
downtimeSchema.statics.countByIpAddress = async function(ipAddress) {
    return await this.countDocuments({ ipAddress });
};

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
        const { status, location, search, since } = req.query;
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
        
        // If since parameter exists, only return IPs updated after that timestamp
        if (since) {
            const sinceDate = new Date(parseInt(since));
            query.lastChecked = { $gt: sinceDate };
        }
        
        // Use lean() for better performance
        const ips = await IP.find(query).sort({ address: 1 }).lean();
        
        // Return current timestamp along with data for frontend tracking
        res.send({
            timestamp: Date.now(),
            data: ips
        });
    } catch (error) {
        console.error('Error fetching IPs:', error);
        res.status(500).send({ error: 'Failed to fetch IP addresses' });
    }
});
// Add a new endpoint for getting deleted IPs (optional enhancement)
app.get('/api/deleted-ips', async (req, res) => {
    try {
        const { since } = req.query;
        
        // This would require a DeletedIP model to track deletions
        // For now, we're just demonstrating the concept
        const deletedIps = [];
        
        res.send(deletedIps);
    } catch (error) {
        console.error('Error fetching deleted IPs:', error);
        res.status(500).send({ error: 'Failed to fetch deleted IPs' });
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

// API to download downtime history as CSV with filtering - FIXED
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
        
        // Handle empty data case
        if (data.length === 0) {
            data.push({
                address: 'No data',
                timestamp: 'No data',
                duration: 'No data'
            });
        }
        
        const parser = new Parser(opts);
        const csv = parser.parse(data);
        
        // Use a unique filename based on timestamp to avoid caching issues
        const timestamp = new Date().getTime();
        const filePath = path.join(__dirname, `downtime_history_${timestamp}.csv`);
        fs.writeFileSync(filePath, csv);

        res.download(filePath, 'downtime_history.csv', (err) => {
            if (err) {
                console.error('Error downloading the file:', err);
                res.status(500).send('Error downloading the file');
            }
            
            // Clean up: delete the file after sending
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
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
// Improve the worker thread ping implementation
// Place this in the worker thread implementation section

if (!isMainThread) {
    const { ipAddresses } = workerData;
    
    // Use Promise.all with concurrency limit to avoid system overload
    const batchSize = 10; // Process 10 IPs at a time within each worker
    const results = [];
    
    async function processBatch(batch) {
        const batchResults = await Promise.all(batch.map(async (ip) => {
            try {
                // Add a timeout to prevent hanging pings
                const res = await ping.promise.probe(ip, {
                    timeout: 2, // 2 second timeout
                    extra: ['-c', '1'], // Just send 1 packet
                });
                return {
                    address: ip,
                    alive: res.alive,
                    time: res.time
                };
            } catch (error) {
                console.error(`Error pinging ${ip}:`, error);
                return {
                    address: ip,
                    alive: false,
                    time: null,
                    error: error.message
                };
            }
        }));
        
        results.push(...batchResults);
    }
    
    // Split ipAddresses into batches
    const batches = [];
    for (let i = 0; i < ipAddresses.length; i += batchSize) {
        batches.push(ipAddresses.slice(i, i + batchSize));
    }
    
    // Process batches sequentially to control concurrency
    (async () => {
        for (const batch of batches) {
            await processBatch(batch);
        }
        parentPort.postMessage(results);
    })();
} else {
    // In the main thread, add better error handling and retry logic
    async function runPingCycle() {
        try {
            // Get all IPs from DB - only fetch necessary fields for better performance
            const ips = await IP.find({}, 'address status location').lean();
            
            if (ips.length === 0) {
                setTimeout(runPingCycle, 5000);
                return;
            }
            
            // Better worker distribution based on IP count
            const ipCount = ips.length;
            const maxWorkers = Math.min(os.cpus().length, 4); // Limit to 4 workers max
            const optimalWorkerCount = Math.min(maxWorkers, Math.ceil(ipCount / 50)); // 1 worker per 50 IPs, up to max
            
            // Distribute IPs evenly across workers
            const batchSize = Math.ceil(ipCount / optimalWorkerCount);
            const batches = [];
            
            for (let i = 0; i < ipCount; i += batchSize) {
                batches.push(ips.slice(i, i + batchSize).map(ip => ip.address));
            }
            
            // Add retry logic for failed worker threads
            async function processBatchWithRetry(batch, retries = 2) {
                try {
                    return await pingInWorker(batch);
                } catch (error) {
                    console.error(`Worker thread error (${retries} retries left):`, error);
                    if (retries > 0) {
                        console.log('Retrying batch...');
                        return processBatchWithRetry(batch, retries - 1);
                    }
                    
                    // If all retries fail, return IPs as unreachable
                    console.error('All retries failed, marking IPs as down');
                    return batch.map(ip => ({
                        address: ip,
                        alive: false,
                        time: null,
                        error: 'Worker thread failed after retries'
                    }));
                }
            }
            
            // Process each batch with retry capability
            const batchPromises = batches.map(batch => processBatchWithRetry(batch));
            const batchResults = await Promise.all(batchPromises);
            
            // Flatten results
            const results = batchResults.flat();
            
            // Update DB with results - this part would be replaced by the bulkWrite implementation
            // from the performance-optimizations artifact
            
            // Add memory usage logging for monitoring
            const memUsage = process.memoryUsage();
            console.log(`Memory usage: RSS ${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
            
            // Dynamic scheduling based on load
            const cycleTime = 5000; // Default 5 seconds
            setTimeout(runPingCycle, cycleTime);
        } catch (error) {
            console.error('Error in ping cycle:', error);
            // Continue the cycle after a delay even if there's an error
            setTimeout(runPingCycle, 10000); // Longer delay on error
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