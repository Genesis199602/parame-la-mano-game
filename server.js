const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let jugadores = []; // { id, nombre, puntos }
let turnoActualIdx = 0;
let estadoJuego = {
  letra: "",
  tiempoRestante: 0,
  enCurso: false,
  cuentaRegresiva: false
};
let temporizador = null;
let respuestasRonda = {}; // { socketId: { Categoria: palabra } }
let votosImpugnacion = {}; // { socketIdQueEscribio_categoria: Set(socketIdQueVoto) }

io.on("connection", (socket) => {
  console.log("Nuevo jugador conectado:", socket.id);

  socket.on("unirse", (nombre) => {
    jugadores.push({ id: socket.id, nombre, puntos: 0 });
    io.emit("actualizar_jugadores", jugadores);

    if (jugadores.length === 1) {
      io.to(socket.id).emit("es_tu_turno", true);
    }
  });

  socket.on("iniciar_turno", ({ letra, tiempo }) => {
    estadoJuego = {
      letra: letra.toUpperCase(),
      tiempoRestante: parseInt(tiempo),
      enCurso: true,
      cuentaRegresiva: false
    };
    respuestasRonda = {};
    votosImpugnacion = {};

    io.emit("ronda_iniciada", estadoJuego);

    clearInterval(temporizador);
    temporizador = setInterval(() => {
      estadoJuego.tiempoRestante--;
      io.emit("tick_tiempo", estadoJuego.tiempoRestante);

      if (estadoJuego.tiempoRestante <= 0) {
        clearInterval(temporizador);
        solicitarRespuestas();
      }
    }, 1000);
  });

  socket.on("parame_la_mano", () => {
    if (!estadoJuego.cuentaRegresiva && estadoJuego.enCurso) {
      estadoJuego.cuentaRegresiva = true;
      estadoJuego.tiempoRestante = Math.min(estadoJuego.tiempoRestante, 10);
      io.emit("alerta_parame_la_mano", socket.id);

      clearInterval(temporizador);
      temporizador = setInterval(() => {
        estadoJuego.tiempoRestante--;
        io.emit("tick_tiempo", estadoJuego.tiempoRestante);

        if (estadoJuego.tiempoRestante <= 0) {
          clearInterval(temporizador);
          solicitarRespuestas();
        }
      }, 1000);
    }
  });

  socket.on("enviar_respuestas", (respuestas) => {
    respuestasRonda[socket.id] = respuestas;

    if (Object.keys(respuestasRonda).length >= jugadores.length) {
      iniciarFaseVotacion();
    }
  });

  socket.on("votar_invalida", ({ autorId, categoria, esInvalida }) => {
    const clave = `${autorId}_${categoria}`;
    if (!votosImpugnacion[clave]) {
      votosImpugnacion[clave] = new Set();
    }

    if (esInvalida) {
      votosImpugnacion[clave].add(socket.id);
    } else {
      votosImpugnacion[clave].delete(socket.id);
    }

    io.emit("actualizar_votos", {
      clave,
      totalVotosEnContra: votosImpugnacion[clave].size
    });
  });

  socket.on("finalizar_votacion", () => {
    calcularResultados();
  });

  socket.on("disconnect", () => {
    jugadores = jugadores.filter((j) => j.id !== socket.id);
    io.emit("actualizar_jugadores", jugadores);
  });
});

function solicitarRespuestas() {
  estadoJuego.enCurso = false;
  io.emit("fin_tiempo");
}

function iniciarFaseVotacion() {
  const listaRespuestas = [];
  
  jugadores.forEach(j => {
    listaRespuestas.push({
      jugadorId: j.id,
      nombre: j.nombre,
      respuestas: respuestasRonda[j.id] || {}
    });
  });

  io.emit("iniciar_votacion", {
    listaRespuestas,
    letra: estadoJuego.letra
  });
}

function calcularResultados() {
  const categorias = ["nombre", "apellido", "ciudad", "animal", "fruta", "cosa"];
  const puntosRonda = {};
  const umbralAnulacion = Math.ceil(jugadores.length / 2);

  jugadores.forEach((j) => (puntosRonda[j.id] = 0));

  categorias.forEach((cat) => {
    const conteoPalabras = {};
    let totalRespuestasValidas = 0;

    jugadores.forEach((j) => {
      const resp = respuestasRonda[j.id] ? respuestasRonda[j.id][cat] || "" : "";
      const palabra = resp.trim().toUpperCase();
      const clave = `${j.id}_${cat}`;
      const votosEnContra = votosImpugnacion[clave] ? votosImpugnacion[clave].size : 0;

      if (
        votosEnContra < umbralAnulacion &&
        palabra.startsWith(estadoJuego.letra) &&
        palabra.length > 1
      ) {
        conteoPalabras[palabra] = (conteoPalabras[palabra] || 0) + 1;
        totalRespuestasValidas++;
      }
    });

    jugadores.forEach((j) => {
      const resp = respuestasRonda[j.id] ? respuestasRonda[j.id][cat] || "" : "";
      const palabra = resp.trim().toUpperCase();
      const clave = `${j.id}_${cat}`;
      const votosEnContra = votosImpugnacion[clave] ? votosImpugnacion[clave].size : 0;

      if (
        votosEnContra >= umbralAnulacion ||
        !palabra.startsWith(estadoJuego.letra) ||
        palabra.length <= 1
      ) {
        return;
      }

      const repeticiones = conteoPalabras[palabra];

      if (
        repeticiones === 1 &&
        totalRespuestasValidas > 2 &&
        Object.values(conteoPalabras).includes(totalRespuestasValidas - 1)
      ) {
        puntosRonda[j.id] += 150;
      } else if (repeticiones === 1) {
        puntosRonda[j.id] += 100;
      } else {
        puntosRonda[j.id] += 50;
      }
    });
  });

  jugadores.forEach((j) => {
    j.puntos += puntosRonda[j.id] || 0;
  });

  turnoActualIdx = (turnoActualIdx + 1) % jugadores.length;

  io.emit("resultados_ronda", {
    puntosRonda,
    jugadores,
    respuestas: respuestasRonda
  });

  if (jugadores[turnoActualIdx]) {
    io.to(jugadores[turnoActualIdx].id).emit("es_tu_turno", true);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));
