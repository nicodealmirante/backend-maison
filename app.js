const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();
const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Conexión a MongoDB (Railway provee la URI en variables de entorno)
const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/maison_db';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Conectado a MongoDB'))
  .catch(err => console.error('❌ Error de conexión:', err));

// Esquema de Turnos
const AppointmentSchema = new mongoose.Schema({
  client: { type: String, required: true },
  phone: { type: String, required: true },
  service: { type: String, required: true },
  category: { type: String, required: true },
  date: { type: String, required: true }, // Formato YYYY-MM-DD
  time: { type: String, required: true }, // Formato HH:mm
  status: { 
    type: String, 
    enum: ['Pendiente', 'Confirmado', 'Cancelado'], 
    default: 'Pendiente' 
  },
  createdAt: { type: Date, default: Date.now }
});

const Appointment = mongoose.model('Appointment', AppointmentSchema);

// --- RUTAS API ---

// 1. Obtener todos los turnos (con filtro opcional por categoría)
app.get('/api/appointments', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category && category !== 'Todos' ? { category } : {};
    const appointments = await Appointment.find(filter).sort({ date: 1, time: 1 });
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
    res.status(201).json(newAppointment);
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

// Puerto de Railway
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Maison corriendo en puerto ${PORT}`);
});
