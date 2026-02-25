const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const mercadopago = require('mercadopago');

dotenv.config();
const app = express();

// configurar MercadoPago
mercadopago.configurations.setAccessToken(process.env.MP_ACCESS_TOKEN || '');

// Middlewares
app.use(cors());
app.use(express.json());

// Conexión a MongoDB (Railway provee la URI en variables de entorno)
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/maison_db';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB'))
  .catch(err => console.error('❌ Error de conexión:', err));

// --- Esquemas / Modelos ---

// Esquema de Servicios
const ServiceSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  category: { type: String, required: true },
  price: { type: Number, default: 0 },
  description: { type: String }
});
const Service = mongoose.model('Service', ServiceSchema);

// Esquema de Profesionales
const ProfessionalSchema = new mongoose.Schema({
  name: { type: String, required: true },
  specialties: [{ type: String }], // categorías en las que trabaja
  phone: { type: String }
});
const Professional = mongoose.model('Professional', ProfessionalSchema);

// Esquema de Turnos
const AppointmentSchema = new mongoose.Schema({
  client: { type: String, required: true },
  phone: { type: String, required: true },
  service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  category: { type: String, required: true },
  professional: { type: mongoose.Schema.Types.ObjectId, ref: 'Professional', required: true },
  date: { type: String, required: true }, // Formato YYYY-MM-DD
  time: { type: String, required: true }, // Formato HH:mm
  status: { 
    type: String, 
    enum: ['Pendiente', 'Confirmado', 'Cancelado'], 
    default: 'Pendiente' 
  },
  payment: {
    preferenceId: { type: String },
    status: { type: String, enum: ['pending', 'paid', 'cancelled'], default: 'pending' },
    amount: { type: Number }
  },
  createdAt: { type: Date, default: Date.now }
});

const Appointment = mongoose.model('Appointment', AppointmentSchema);

// --- RUTAS API ---

// Utilidades de filtro para turnos
function buildAppointmentFilter(query) {
  const filter = {};
  if (query.category && query.category !== 'Todos') filter.category = query.category;
  if (query.service) filter.service = query.service;
  if (query.professional) filter.professional = query.professional;
  if (query.status) filter.status = query.status;
  if (query.date) filter.date = query.date;
  return filter;
}

// 1. Obtener todos los turnos (con filtros opcionales)
app.get('/api/appointments', async (req, res) => {
  try {
    const filter = buildAppointmentFilter(req.query);
    const appointments = await Appointment.find(filter)
      .populate('service')
      .populate('professional')
      .sort({ date: 1, time: 1 });
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 2. Crear un nuevo turno
app.post('/api/appointments', async (req, res) => {
  try {
    const newAppointment = new Appointment(req.body);
    await newAppointment.save();
    const populated = await Appointment.findById(newAppointment._id)
      .populate('service')
      .populate('professional');
    res.status(201).json(populated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// 3. Actualizar estado de un turno (Admin)
app.patch('/api/appointments/:id', async (req, res) => {
  try {
    const updated = await Appointment.findByIdAndUpdate(
      req.params.id, 
      { status: req.body.status },
      { new: true }
    );
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// 4. Eliminar turno (Admin)
app.delete('/api/appointments/:id', async (req, res) => {
  try {
    await Appointment.findByIdAndDelete(req.params.id);
    res.json({ message: 'Turno eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// --- Mercado Pago: solicitud de seña ---
// Genera preferencia de pago para un turno y guarda información en el documento
app.post('/api/appointments/:id/deposit', async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id).populate('service');
    if (!appointment) return res.status(404).json({ message: 'Turno no encontrado' });

    // calcular monto de la seña (ej: 50% del precio del servicio o un valor fijo)
    const price = (appointment.service && appointment.service.price) || 0;
    const amount = price * 0.5; // ajuste según política

    const preference = {
      items: [
        {
          title: `Seña por turno - ${appointment.service ? appointment.service.name : 'Servicio'}`,
          quantity: 1,
          currency_id: 'ARS',
          unit_price: amount
        }
      ],
      external_reference: appointment._id.toString(),
      back_urls: {
        success: process.env.MP_BACK_URL_SUCCESS || '',
        failure: process.env.MP_BACK_URL_FAILURE || '',
        pending: process.env.MP_BACK_URL_PENDING || ''
      },
      auto_return: 'approved'
    };

    const mpResponse = await mercadopago.preferences.create(preference);
    appointment.payment = {
      preferenceId: mpResponse.body.id,
      status: 'pending',
      amount
    };
    await appointment.save();

    res.json({ init_point: mpResponse.body.init_point, preference: mpResponse.body });
  } catch (error) {
    console.error('MercadoPago error', error);
    res.status(500).json({ message: error.message });
  }
});

// Webhook de Mercado Pago para actualizar estado de pago
app.post('/api/mercadopago/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  const { type, 'data.id': paymentId, action } = req.body;
  try {
    if (type === 'payment' && action === 'payment.created') {
      // buscar pago y actualizar turno
      const payment = await mercadopago.payment.findById(paymentId);
      const extRef = payment.body.external_reference;
      if (extRef) {
        const appt = await Appointment.findById(extRef);
        if (appt) {
          appt.payment.status = payment.body.status;
          if (payment.body.status === 'approved') appt.status = 'Confirmado';
          await appt.save();
        }
      }
    }
    // responder 200 siempre para que MP no reintente
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error', err);
    res.sendStatus(500);
  }
});


// --- CRUD Servicios ---
// obtener lista
app.get('/api/services', async (req, res) => {
  try {
    const services = await Service.find().sort({ name: 1 });
    res.json(services);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
// crear
app.post('/api/services', async (req, res) => {
  try {
    const service = new Service(req.body);
    await service.save();
    res.status(201).json(service);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});
// actualizar
app.patch('/api/services/:id', async (req, res) => {
  try {
    const updated = await Service.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});
// borrar
app.delete('/api/services/:id', async (req, res) => {
  try {
    await Service.findByIdAndDelete(req.params.id);
    res.json({ message: 'Servicio eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// --- CRUD Profesionales ---
app.get('/api/professionals', async (req, res) => {
  try {
    const professionals = await Professional.find().sort({ name: 1 });
    res.json(professionals);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
app.post('/api/professionals', async (req, res) => {
  try {
    const prof = new Professional(req.body);
    await prof.save();
    res.status(201).json(prof);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});
app.patch('/api/professionals/:id', async (req, res) => {
  try {
    const updated = await Professional.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});
app.delete('/api/professionals/:id', async (req, res) => {
  try {
    await Professional.findByIdAndDelete(req.params.id);
    res.json({ message: 'Profesional eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Puerto de Railway
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Maison corriendo en puerto ${PORT}`);
});
