const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

// Configuración de Express y Middleware
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Configuración de MongoDB
mongoose.set('strictQuery', false);
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Conexión a MongoDB exitosa'))
  .catch(err => console.log('Error en la conexión a MongoDB: ', err));

// Manejar eventos de conexión
mongoose.connection.on('disconnected', () => {
  console.log('Se perdió la conexión a MongoDB');
  mongoose.connect(process.env.MONGODB_URI);
});

mongoose.connection.on('error', (err) => {
  console.error('Error de conexión a MongoDB:', err);
  mongoose.connect(process.env.MONGODB_URI);
});

// Modelos de Mongoose
const Subscription = mongoose.model('ClientSubscription', new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  planId: { type: String, required: true },
  paypalSubscriptionId: { type: String },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date },
  status: { type: String, default: 'pending', enum: ['pending', 'active', 'cancelled'] }
}));

const SubscriptionData = mongoose.model('SubscriptionsData', new mongoose.Schema({
  planId: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, required: true },
  price: { type: Number, required: true },
  paypalPlanId: { type: String }
}), 'SubscriptionsData');

// Configuración de PayPal
const getPayPalAccessToken = async () => {
  try {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post(
      `${process.env.PAYPAL_BASE_URL}/v1/oauth2/token`, 
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    return response.data.access_token;
  } catch (error) {
    console.error('Error obteniendo token de PayPal:', error.response ? error.response.data : error.message);
    throw error;
  }
};

// Rutas de Suscripciones

// GET: Obtener planes de suscripción disponibles
app.get('/api/subscriptions', async (req, res) => {
  try {
    const subscriptionsData = await SubscriptionData.find();
    
    if (!subscriptionsData.length) {
      return res.status(404).json({ message: 'No hay suscripciones disponibles' });
    }
    
    const response = subscriptionsData.map(plan => ({
      _id: plan._id,
      planId: plan.planId,
      name: plan.name,
      description: plan.description,
      price: plan.price
    }));
    
    res.json(response);
  } catch (error) {
    console.error('Error detallado al obtener suscripciones:', error);
    res.status(500).json({
      message: 'Error al obtener las suscripciones',
      errorDetails: error.message
    });
  }
});

// POST: Crear suscripción en PayPal
app.post('/api/create-subscription', async (req, res) => {
  try {
    const { name, email, phone, planId } = req.body;
    
    // Obtener detalles del plan
    const subscriptionPlan = await SubscriptionData.find({ planId });
    if (!subscriptionPlan) {
      return res.status(404).json({ message: 'Plan de suscripción no encontrado' });
    }

    // Obtener token de acceso de PayPal
    const accessToken = await getPayPalAccessToken();

    // Crear suscripción en PayPal
    const subscriptionResponse = await axios.post(
      `${process.env.PAYPAL_BASE_URL}/v1/billing/subscriptions`,
      {
        plan_id: subscriptionPlan[0].planId,
        start_time: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        quantity: 1,
        subscriber: {
          name: {
            given_name: name
          },
          email_address: email
        },
        application_context: {
          brand_name: 'Proyecto UmbrellaCorp',
          locale: 'es-ES',
          user_action: 'SUBSCRIBE_NOW',
          return_url: `${process.env.APP_URL}/success`,
          cancel_url: `${process.env.APP_URL}/cancel`
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    // Crear registro de suscripción en MongoDB
    const newSubscription = new Subscription({
      name,
      email,
      phone,
      planId: subscriptionPlan[0].planId,
      paypalSubscriptionId: subscriptionResponse.data.id,
      status: 'pending'
    });

    const savedSubscription = await newSubscription.save();
    console.log("Después de guardar:", savedSubscription);

    res.json({
      subscriptionId: newSubscription.plantId,
      paypalLink: subscriptionResponse.data.links.find(link => link.rel === 'approve').href
    });

  } catch (error) {
    console.error('Error creando suscripción:', error.response ? error.response.data : error.message);
    res.status(500).json({
      message: 'Error al crear suscripción',
      errorDetails: error.response ? error.response.data : error.message
    });
  }
});

// GET: Verificar estado de suscripción
app.get('/api/subscription-status/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    
    // Obtener suscripción de MongoDB
    const subscriptionList = await Subscription.find({ paypalSubscriptionId: subscriptionId });
    const subscription = subscriptionList[0]

    if (!subscription) {
      return res.status(404).json({ message: 'Suscripción no encontrada' });
    }

    // Obtener token de acceso de PayPal
    const accessToken = await getPayPalAccessToken();

    // Verificar estado en PayPal
    const paypalResponse = await axios.get(
      `${process.env.PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscription.paypalSubscriptionId}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    // Actualizar estado de suscripción
    subscription.status = paypalResponse.data.status.toLowerCase();
    await subscription.save();

    res.json({
      subscriptionId: subscription._id,
      status: subscription.status,
      paypalSubscriptionId: subscription.paypalSubscriptionId
    });
  } catch (error) {
    console.error('Error verificando suscripción:', error.response ? error.response.data : error.message);
    res.status(500).json({
      message: 'Error al verificar suscripción',
      errorDetails: error.response ? error.response.data : error.message
    });
  }
});

// POST: Cancelar suscripción
app.post('/api/cancel-subscription/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    
    // Obtener suscripción de MongoDB
    const subscriptionList = await Subscription.find({ paypalSubscriptionId : subscriptionId });
    const subscription = subscriptionList[0]
    if (!subscription) {
      return res.status(404).json({ message: 'Suscripción no encontrada' });
    }

    // Obtener token de acceso de PayPal
    const accessToken = await getPayPalAccessToken();

    // Cancelar suscripción en PayPal
    await axios.post(
      `${process.env.PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscription.paypalSubscriptionId}/cancel`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    // Actualizar estado en MongoDB
    subscription.status = 'cancelled';
    subscription.endDate = new Date();
    await subscription.save();

    res.json({
      message: 'Suscripción cancelada exitosamente',
      subscriptionId: subscription.paypalSubscriptionId
    });
  } catch (error) {
    console.error('Error cancelando suscripción:', error.response ? error.response.data : error.message);
    res.status(500).json({
      message: 'Error al cancelar suscripción',
      errorDetails: error.response ? error.response.data : error.message
    });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});

// Exportar para pruebas o uso en otros módulos
module.exports = app;