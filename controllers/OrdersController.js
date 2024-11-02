let express = require('express');
let app = express.Router();
let mongoose = require('mongoose');
const bodyParser = require('body-parser');
const OrdersModel = require('../models/OrdersModel');
const ProductsModel = require('../models/ProductsModel');
const urlEncoded = bodyParser.urlencoded({extended: false});
const unirest = require('unirest');
const LocationsModel = require('../models/LocationsModel');
const verifyToken = require('../middleware/authMiddleware');
const UsersModel = require('../models/UsersModel');
const SENDMAIL = require('../middleware/SendMail');


function sendOrderEmail(template, recepient, callback)
{
    SENDMAIL("Your Order Has Been Confirmed", template, recepient)
   .then(response => {
        console.log("Email Sent");
        callback(true, "Success");
    })
    .catch(error => {
        console.error('Error sending email:', error);
        callback(false, error)
    }); 
}

function accessToken(req, res, next){

    unirest('POST', 'https://pay.pesapal.com/v3/api/Auth/RequestToken')
    .headers({
        "Content-Type" : "application/json",
        "Accept" : "application/json"
    })
    .send({
        "consumer_key" : process.env.CONSUMER_KEY,
        "consumer_secret" : process.env.CONSUMER_SECRET
    })
    .end(response => {
        if (response.error) throw new Error(response.error);

        let token = response.raw_body.token

        req.access_token = token;

        next();
    });
}

function getTodayDate() {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0'); // January is 0!
  const year = today.getFullYear();

  return `${day}/${month}/${year}`;
}

//Register IPN callback URL
app.get('/RegisterIpn', accessToken, function(req, res){

    unirest('POST', 'https://pay.pesapal.com/v3/api/URLSetup/RegisterIPN')
    .headers({
        "Content-Type" : "application/json",
        "Accept" : "application/json",
        "Authorization": "Bearer " + req.access_token
    })
    .send({
        "url" : process.env.SERVER_URL +  "/ipn_callback",
        "ipn_notification_type" : "POST"
    })
    .end(response => {
        if (response.error) throw new Error(response.error);
        console.log(response.raw_body);
        res.json(response.raw_body);
    });
    
})

const phoneRegex = /^0[0-9]{9}$/;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

//Submit Order Request
app.post('/Checkout', urlEncoded, accessToken, verifyToken, function(req, res){
    let date = getTodayDate();

    // Validate email
    if (!emailRegex.test(req.body.email)) {
        return res.status(400).json("Invalid email address");
    }

    // Validate phone number
    if (req.body.phoneNumber && !phoneRegex.test(req.body.phoneNumber)) {
        return res.status(400).json("Invalid phone number");
    }

    let received = {
        OrderTrackingId : "",
        user_id: req.userId,
        items : req.body.products,
        completion_status: "pending",
        deliveryLocation : req.body.location,
        delivery_status : "pending",
        order_date : date,
        delivery_date : "",
        min_price: req.body.minPrice
    }

    let TotalPrice = 0;
    let location =  received.deliveryLocation;

    LocationsModel.findById(location)
    .then(locationData => {
        let delivery_cost = locationData.price;
        let promises = received.items.map( item => {
            return ProductsModel.findOne({ _id : item._id })
            .then(response => {
                if(item.quantity < 1){
                    TotalPrice = TotalPrice + ( response.price * 1);
                }else{
                    TotalPrice = TotalPrice + ( response.price * item.quantity);
                }
            })
        })
        Promise.all(promises)
        .then(() => {
            received.total_price = TotalPrice;
            received.delivery_cost = delivery_cost;
            received.amount_paid = received.min_price;

            const grandTotal = received.total_price + received.delivery_cost;

            if(received.min_price < grandTotal){
                return res.status(400).json("Min price is invalid");
            }else{
                UsersModel.findOne({ _id: received.user_id})
                .then(user => {
                    OrdersModel(received).save()
                    .then(data => {
            
                        unirest('POST', 'https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest')
                        .headers({
                            'Content-Type':'application/json',
                            'Accept':'application/json',
                            'Authorization':'Bearer ' + req.access_token
                        })
                        .send({
                            "id": data._id, //order id
                            "currency": "KES",
                            "amount":  received.min_price,
                            "description": "Payment for Furniture",
                            "callback_url": process.env.CLIENT_URL +  "/confirm",
                            "cancellation_url": process.env.CLIENT_URL + "/cancel", //Replace with frontend failed Page URL
                            "redirect_mode": "",
                            "notification_id": process.env.IPN_ID,
                            "branch": "Utawala",
                            "billing_address": {
                                "email_address": user.email,
                                "phone_number": user.phoneNumber,
                                "country_code": "KE",
                                "first_name": user.first_name,
                                "middle_name": "",
                                "last_name": user.second_name,
                                "line_1": "",
                                "line_2": "",
                                "city": "",
                                "state": "",
                                "postal_code": "",
                                "zip_code": ""
                            }
                        })
                        .end(response =>{
                            if (response.error) throw new Error(response.error);
            
                            //Update Order with tracking Id
                            OrdersModel.findOneAndUpdate({_id: data._id}, { OrderTrackingId: response.raw_body.order_tracking_id}, {new: false})
                            .then( data => {
                                res.json(response.raw_body)
                            })
                            .catch( err => {
                                res.status(500).json(err);
                            })
                        })
                    })
                    .catch(function(err){
                        res.status(500).json(err);
                    })
                })
                
            }
        })
        .catch(error => {
            console.log(error);
            // Handle errors here
            res.status(500).json("Server Error. Try again");
        });
    })   
})

//Receives IPN notifcations
app.post('/ipn_callback', accessToken, urlEncoded, function(req, res){
    console.log(`${req.body.OrderTrackingId} ipn callback`);
    //Get transaction Status
    unirest('GET', `https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${req.body.OrderTrackingId}`)
    .headers({
        "Content-Type" : "application/json",
        "Accept" : "application/json",
        "Authorization": "Bearer " + req.access_token
    })
    .end(response =>{
        if (response.error) throw new Error(response.error);

        let result = JSON.parse(response.raw_body);

        OrdersModel.findOneAndUpdate({OrderTrackingId: req.body.OrderTrackingId}, { completion_status: result.payment_status_description},{ new: false })
        .then( mongoData => {     
            if (result.payment_status_description.toLowerCase() == "completed") {
                UsersModel.findOne({ _id: mongoData.user_id})
                .then(user => {
                    // Send Success email if paid
                    LocationsModel.findById(mongoData.deliveryLocation)
                    .then(locationData => {
                        let template = `
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <meta charset="utf-8">
                                <title>Order Confirmed</title>
                                <style>
                                body {
                                    font-family: Arial, sans-serif;
                                    color: #000;
                                    background-color: #fff;
                                }
                                #heading {
                                    text-align: center;
                                    font-size: 24px;
                                    font-weight: bold;
                                    margin-bottom: 20px;
                                }
                                .table-container {
                                    margin-top: 20px;
                                }
                                table {
                                    width: 100%;
                                    border-collapse: collapse;
                                }
                                th, td {
                                    padding: 8px;
                                    text-align: left;
                                    border: 1px solid #000;
                                }
                                .info {
                                    margin-top: 10px;
                                    font-weight: bold;
                                }
                                th {
                                    background-color: #000;
                                    color: #fff;
                                }
                                .total-row {
                                    font-weight: bold;
                                }
                                .footer {
                                    text-align: center;
                                    margin: auto;
                                    margin-top: 10px;
                                    width: 50%;
                                }
                                #footerText {
                                    font-size: 20px;
                                }
                                </style>
                            </head>
                            <body>
                                <div id="heading">Your Order Has Been Confirmed</div>
                            
                                <div class="info">Order Tracking Number: ${mongoData.OrderTrackingId}</div>
                                <div class="info">Order Date: ${mongoData.order_date}</div>
                                <div class="info">Full Name: ${user.first_name} ${user.second_name}</div>
                                <div class="info">Delivery Location: ${locationData.town}</div>
                            
                                <div class="table-container">
                                <div>Products</div>
                                <table>
                                    <thead>
                                    <tr>
                                        <th>Product</th>
                                        <th>Quantity</th>
                                        <th>Price</th>
                                    </tr>
                                    </thead>
                                    <tbody>
                                    ${mongoData.items.map(item => 
                                        `<tr>
                                        <td>${item.productName}</td>
                                        <td>${item.quantity}</td>
                                        <td>KSH. ${item.price}/=</td>
                                        </tr>`
                                    ).join('')}
                                    </tbody>
                                </table>
                                </div>
                                <div class="info">Delivery Cost: KSH. ${mongoData.delivery_cost}/=</div>
                                <div class="info total-row">Total Amount: KSH. ${mongoData.amount_paid}/=</div>
                                <div class="footer">Our Sales Agent Will Contact You To Make Arrangements for Delivery</div>
                                <div class="footer" id="footerText">Thank You For Shopping With Us!</div>
                                <div class="footer">Crafted Furniture Collection, 2024</div>
                            </body>
                            </html>
                            `;
                        sendOrderEmail(template, user.email, (response, info)=>{
                            if(response){
                                console.log(info)
                                res.json("Success");
                            }else{
                                console.log(info)
                                res.json("Success");
                            }
                        })
                        
                    })
                    
                })
                .catch(err => {
                    res.status(500).json("Server Error");
                });
            }else{
                res.json("Not succesfully paid");
            }
        })
        .catch(err =>{
            console.log(err);
            res.status(500).json(err);
        })
    })
})

app.get('/ConfirmPayment/:id', urlEncoded, function(req, res){

    //Check if Id is valid mongo Id
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
    {
        res.json('Invalid Id')
    }else{
        OrdersModel.findById(req.params.id)
        .then(data => {
            if(data){ //Check id data has been found
                if(data.completion_status === "Completed"){
                    res.status(200).json('Completed')
                }else if(data.completion_status === "Failed"){
                    res.status(402).json('Failed')
                }else if(data.completion_status === "pending"){
                    res.status(409).json('Pending')
                }

            }else{
                res.status(404).json('Order Does Not Exist');
            }
        })
        .catch(err => {
            res.status(500).json('Server Error');  
        })
    }
})

//Get registered IPNs for Particular Merchant
app.get('/RegisteredIpns', accessToken, function(req, res){
    unirest('GET', 'https://pay.pesapal.com/v3/api/URLSetup/GetIpnList')
    .headers({
        "Content-Type" : "application/json",
        "Accept" : "application/json",
        "Authorization": "Bearer " + req.access_token
    })
    .end(response => {
        if (response.error) throw new Error(response.error);

        res.json(response.raw_body)
    });
})

app.get('/GetAllOrders', verifyToken, function(req, res){
    OrdersModel.find({ completion_status: "Completed" })
    .then(data => {
        let promises = data.map(order => {
            // Find the user who placed the order
            return UsersModel.findOne({ _id: order.user_id })
            .then(userResult => {
                // Map through each item in the order to find the item's owner details
                let itemPromises = order.items.map(item => {
                    return UsersModel.findOne({ _id: item.ownedBy })
                    .then(ownerResult => {
                        return {
                            ...item, // Keep the item data
                            owner_first_name: ownerResult.first_name,
                            owner_second_name: ownerResult.second_name,
                            owner_email : ownerResult.email,
                            owner_phone_number : ownerResult.phoneNumber
                        };
                    });
                });

                // Wait for all the item promises to resolve
                return Promise.all(itemPromises).then(updatedItems => {
                    return {
                        ...order.toObject(), // Convert the Mongoose document to a plain JavaScript object
                        items: updatedItems, // Updated items with owner's details
                        first_name: userResult.first_name, 
                        second_name: userResult.second_name, 
                        email: userResult.email, 
                        phoneNumber: userResult.phoneNumber
                    };
                });
            });
        });

        // Wait for all the promises to resolve
        return Promise.all(promises);
    })
    .then(newData => {
        res.json(newData);
    })
    .catch(err => {
        console.log(err);
    });
});


//Get My Orders
app.get('/GetMyOrders', verifyToken, function(req, res){
    OrdersModel.find({$and : [{ completion_status: "Completed", user_id: req.userId}]})
    .then(newData => {
        res.json(newData);
    })
    .catch(err =>{
        console.log(err);
    })
})

//Get Delivered Orders
app.get('/GetDeliveredOrders', verifyToken, function(req, res){
    OrdersModel.find({ delivery_status: 'delivered' })
    .then(data => {
        let promises = data.map(order => {
            // Find the user who placed the order
            return UsersModel.findOne({ _id: order.user_id })
            .then(userResult => {
                // Map through each item in the order to find the item's owner details
                let itemPromises = order.items.map(item => {
                    return UsersModel.findOne({ _id: item.ownedBy })
                    .then(ownerResult => {
                        return {
                            ...item, // Keep the item data
                            owner_first_name: ownerResult.first_name,
                            owner_second_name: ownerResult.second_name,
                            owner_email : ownerResult.email,
                            owner_phone_number : ownerResult.phoneNumber
                        };
                    });
                });

                // Wait for all the item promises to resolve
                return Promise.all(itemPromises).then(updatedItems => {
                    return {
                        ...order.toObject(), // Convert the Mongoose document to a plain JavaScript object
                        items: updatedItems, // Updated items with owner's details
                        first_name: userResult.first_name, 
                        second_name: userResult.second_name, 
                        owner_email: userResult.email, 
                        owner_phoneNumber: userResult.phoneNumber
                    };
                });
            });
        });

        // Wait for all the promises to resolve
        return Promise.all(promises);
    })
    .then(newData => {
        res.json(newData);
    })
    .catch(err => {
        console.log(err);
        res.status(500).send("Error fetching delivered orders");
    });
});


//Get Orders Pending Delivery
app.get('/GetPendingOrders', verifyToken, function(req, res) {
    OrdersModel.find({ $and: [{ delivery_status: 'pending' }, { completion_status: 'Completed' }] })
    .then(data => {
        let promises = data.map(order => {
            // Find the user who placed the order
            return UsersModel.findOne({ _id: order.user_id })
            .then(userResult => {
                // Map through each item in the order to find the item's owner details
                let itemPromises = order.items.map(item => {
                    return UsersModel.findOne({ _id: item.ownedBy })
                    .then(ownerResult => {
                        return {
                            ...item, // Keep the item data
                            owner_first_name: ownerResult.first_name,
                            owner_second_name: ownerResult.second_name, 
                            owner_email: userResult.email, 
                            owner_phoneNumber: userResult.phoneNumber
                        };
                    });
                });

                // Wait for all the item promises to resolve
                return Promise.all(itemPromises).then(updatedItems => {
                    return {
                        ...order.toObject(), // Convert the Mongoose document to a plain JavaScript object
                        items: updatedItems, // Updated items with owner's details
                        first_name: userResult.first_name, 
                        second_name: userResult.second_name, 
                        owner_email: userResult.email, 
                        owner_phoneNumber: userResult.phoneNumber
                    };
                });
            });
        });

        // Wait for all the promises to resolve
        return Promise.all(promises);
    })
    .then(newData => {
        res.json(newData);
    })
    .catch(err => {
        console.log(err);
        res.status(500).send("Error fetching pending orders");
    });
});



//Update Orders On Delivery
app.put('/update_delivery/:id', urlEncoded, verifyToken, function(req, res){
    let date = getTodayDate(); 
    OrdersModel.findByIdAndUpdate(req.params.id,{delivery_status:'delivered', delivery_date: date }, {new: true})
    .then(data => {
        res.json('success')
    })
    .catch(err => console.log('error'))
});

module.exports = app;