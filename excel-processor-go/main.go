package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/xuri/excelize/v2"
)

// ============================================================================
// CONFIGURACIÓN Y VARIABLES GLOBALES
// ============================================================================

var (
	dbPool           *pgxpool.Pool
	backendURL       string
	activeProcesses  = make(map[int]*ProcessStatus)
	activeProcessMux sync.RWMutex
)

type ProcessStatus struct {
	ExcelID   int     `json:"excelId"`
	Filename  string  `json:"filename"`
	Progress  float64 `json:"progress"`
	Total     int     `json:"total"`
	Processed int     `json:"processed"`
	Status    string  `json:"status"`
	Message   string  `json:"message"`
}

// ============================================================================
// HELPERS DE ESTADO
// ============================================================================

func updateActiveProcess(userID int, status *ProcessStatus) {
	activeProcessMux.Lock()
	defer activeProcessMux.Unlock()
	activeProcesses[userID] = status
}

func getActiveProcess(userID int) *ProcessStatus {
	activeProcessMux.RLock()
	defer activeProcessMux.RUnlock()
	return activeProcesses[userID]
}

func deleteActiveProcess(userID int) {
	activeProcessMux.Lock()
	defer activeProcessMux.Unlock()
	delete(activeProcesses, userID)
}

// ============================================================================
// NOTIFICACIÓN HTTP (Simple y confiable)
// ============================================================================

func notifyProgress(excelID, userID int, status *ProcessStatus) {
	// Actualizar estado local
	updateActiveProcess(userID, status)

	// Notificar al backend via HTTP POST (sin autenticación, endpoint público interno)
	go func() {
		payload := map[string]interface{}{
			"excelId":   excelID,
			"userId":    userID,
			"progress":  status.Progress,
			"total":     status.Total,
			"processed": status.Processed,
			"status":    status.Status,
			"message":   status.Message,
			"filename":  status.Filename,
		}

		jsonData, _ := json.Marshal(payload)

		req, err := http.NewRequest("POST", backendURL+"/excel/notify-progress", bytes.NewBuffer(jsonData))
		if err != nil {
			return
		}

		req.Header.Set("Content-Type", "application/json")

		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Printf("⚠️ Error notificando: %v", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode == 200 || resp.StatusCode == 201 {
			log.Printf("📡 Notificado: Excel %d - %s (%.1f%%)", excelID, status.Status, status.Progress)
		} else {
			log.Printf("⚠️ Error respuesta: %d", resp.StatusCode)
		}
	}()
}

// ============================================================================
// PROCESAMIENTO DE EXCEL
// ============================================================================

func processExcel(c *fiber.Ctx) error {
	// Obtener parámetros
	userIDStr := c.FormValue("user_id")
	uploadedBy := c.FormValue("uploaded_by")

	userID, err := strconv.Atoi(userIDStr)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "user_id inválido"})
	}

	// Obtener archivo
	file, err := c.FormFile("file")
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "No se recibió archivo"})
	}

	filename := file.Filename
	if !strings.HasSuffix(strings.ToLower(filename), ".xlsx") && !strings.HasSuffix(strings.ToLower(filename), ".xls") {
		return c.Status(400).JSON(fiber.Map{"error": "El archivo debe ser Excel (.xlsx o .xls)"})
	}

	log.Printf("📊 Procesando archivo: %s para usuario %d", filename, userID)

	// PASO 1: Crear metadata inicial
	ctx := context.Background()
	var excelID int
	err = dbPool.QueryRow(ctx, `
		INSERT INTO excel_metadata (user_id, filename, "totalRecords", "uploadedBy", headers, "isReactive", "uploadedAt")
		VALUES ($1, $2, 0, $3, '[]'::json, true, NOW())
		RETURNING id
	`, userID, filename, uploadedBy).Scan(&excelID)

	if err != nil {
		log.Printf("❌ Error creando metadata: %v", err)
		return c.Status(500).JSON(fiber.Map{"error": "Error creando metadata"})
	}

	log.Printf("💾 Metadata creada (ID: %d)", excelID)

	// PASO 2: Notificar INMEDIATAMENTE que empezó
	status := &ProcessStatus{
		ExcelID:  excelID,
		Filename: filename,
		Status:   "uploading",
		Message:  "Recibiendo archivo...",
	}
	notifyProgress(excelID, userID, status)

	// PASO 3: Guardar archivo temporalmente
	tempFile, err := os.CreateTemp("", "excel-*.xlsx")
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"error": "Error creando archivo temporal"})
	}
	tempPath := tempFile.Name()

	src, _ := file.Open()
	io.Copy(tempFile, src)
	src.Close()
	tempFile.Close()

	fileInfo, _ := os.Stat(tempPath)
	fileSizeMB := float64(fileInfo.Size()) / (1024 * 1024)
	log.Printf("📏 Archivo guardado: %.2f MB", fileSizeMB)

	// Notificar que el archivo fue guardado
	status.Status = "saved"
	status.Message = fmt.Sprintf("Archivo guardado (%.1f MB)", fileSizeMB)
	notifyProgress(excelID, userID, status)

	// PASO 4: Procesar en background
	go processExcelInBackground(excelID, userID, filename, uploadedBy, tempPath, fileSizeMB)

	// PASO 5: Responder inmediatamente
	log.Printf("✅ Excel %d: Respondiendo inmediatamente, procesando en background", excelID)
	return c.JSON(fiber.Map{
		"success":      true,
		"message":      "Excel recibido, procesando en background",
		"excelId":      excelID,
		"recordsCount": 0,
	})
}

func processExcelInBackground(excelID, userID int, filename, uploadedBy, tempPath string, fileSizeMB float64) {
	startTime := time.Now()
	defer os.Remove(tempPath)

	// Helper para notificar
	notify := func(status, message string, progress float64, total, processed int) {
		notifyProgress(excelID, userID, &ProcessStatus{
			ExcelID:   excelID,
			Filename:  filename,
			Status:    status,
			Message:   message,
			Progress:  progress,
			Total:     total,
			Processed: processed,
		})
	}

	// Notificar inicio de lectura
	notify("reading", fmt.Sprintf("Abriendo Excel (%.1f MB)...", fileSizeMB), 0, 0, 0)

	// Abrir Excel con opciones optimizadas
	f, err := excelize.OpenFile(tempPath, excelize.Options{
		UnzipSizeLimit:    10 << 30,          // 10GB
		UnzipXMLSizeLimit: 10 << 30,          // 10GB
		Password:          "",                 // Sin password
		RawCellValue:      false,             // Parsear valores
		ShortDatePattern:  "yyyy-mm-dd",      // Formato de fecha
	})
	if err != nil {
		log.Printf("❌ Error abriendo Excel: %v", err)
		notify("error", "Error abriendo Excel: "+err.Error(), 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}
	defer f.Close()

	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		notify("error", "El Excel no tiene hojas", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}
	sheetName := sheets[0]

	// Notificar que está leyendo
	notify("reading", "Leyendo datos del Excel...", 5, 0, 0)

	// Leer todas las filas de una vez (MÁS RÁPIDO que streaming)
	// GetRows es más rápido que streaming para archivos completos
	rows, err := f.GetRows(sheetName, excelize.Options{
		RawCellValue: false, // Obtener valores formateados
	})
	if err != nil {
		log.Printf("❌ Error leyendo filas: %v", err)
		notify("error", "Error leyendo filas", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	if len(rows) < 2 {
		notify("error", "El Excel no contiene datos", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	readTime := time.Since(startTime)
	log.Printf("📋 Excel leído en %.2fs: %d filas", readTime.Seconds(), len(rows))

	// Notificar lectura completada
	totalRows := len(rows) - 1
	notify("processing", fmt.Sprintf("Excel leído: %d filas en %.1fs", totalRows, readTime.Seconds()), 10, totalRows, 0)

	// Procesar headers
	headers := make([]string, len(rows[0]))
	seen := make(map[string]int)
	for i, col := range rows[0] {
		header := strings.TrimSpace(col)
		if header == "" {
			header = fmt.Sprintf("Columna_%d", i+1)
		}
		if count, exists := seen[header]; exists {
			seen[header] = count + 1
			header = fmt.Sprintf("%s_%d", header, count+1)
		} else {
			seen[header] = 1
		}
		headers[i] = header
	}

	log.Printf("📊 Headers: %d columnas", len(headers))

	// Convertir filas a registros EN PARALELO (OPTIMIZACIÓN)
	records := processRowsParallel(rows[1:], headers)

	log.Printf("📊 Registros válidos: %d", len(records))

	if len(records) == 0 {
		notify("error", "El Excel no contiene datos válidos", 0, 0, 0)
		deleteActiveProcess(userID)
		return
	}

	// Actualizar metadata
	headersJSON, _ := json.Marshal(headers)
	ctx := context.Background()
	dbPool.Exec(ctx, `
		UPDATE excel_metadata 
		SET "totalRecords" = $1, headers = $2::json
		WHERE id = $3
	`, len(records), string(headersJSON), excelID)

	// Notificar inicio de inserción
	notify("inserting", fmt.Sprintf("Insertando %d registros...", len(records)), 15, len(records), 0)

	// Insertar registros en lotes (en paralelo si hay muchos)
	insertRecordsOptimized(ctx, excelID, userID, records, filename)

	// Completado
	elapsed := time.Since(startTime)
	log.Printf("✅ Excel %d completado: %d registros en %.2fs", excelID, len(records), elapsed.Seconds())
	notify("completed", fmt.Sprintf("✅ Completado: %d registros en %.1fs", len(records), elapsed.Seconds()), 100, len(records), len(records))

	// Limpiar después de 3 segundos
	time.Sleep(3 * time.Second)
	deleteActiveProcess(userID)
}

// ============================================================================
// PROCESAMIENTO PARALELO DE FILAS (OPTIMIZACIÓN)
// ============================================================================

// processRowsParallel convierte filas de Excel a registros usando goroutines
// Esto acelera el procesamiento 2-4x en CPUs multi-core
func processRowsParallel(rows [][]string, headers []string) []map[string]interface{} {
	if len(rows) == 0 {
		return []map[string]interface{}{}
	}

	// Configurar workers basado en CPUs disponibles
	numWorkers := runtime.NumCPU()
	if numWorkers > 8 {
		numWorkers = 8 // Limitar a 8 workers máximo
	}

	// Canales para distribuir trabajo
	type job struct {
		index int
		row   []string
	}
	
	type result struct {
		index  int
		record map[string]interface{}
	}

	jobs := make(chan job, len(rows))
	results := make(chan result, len(rows))

	// Pool de sincronización para reutilizar mapas (reduce GC)
	recordPool := sync.Pool{
		New: func() interface{} {
			return make(map[string]interface{}, len(headers))
		},
	}

	// Lanzar workers
	var wg sync.WaitGroup
	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				// Obtener mapa del pool
				record := recordPool.Get().(map[string]interface{})
				
				// Limpiar el mapa (puede venir del pool con datos)
				for k := range record {
					delete(record, k)
				}
				
				isEmpty := true
				row := job.row
				
				// Procesar cada columna
				for j, header := range headers {
					if j < len(row) {
						value := strings.TrimSpace(row[j])
						if value != "" {
							record[header] = value
							isEmpty = false
						}
					}
				}
				
				// Solo enviar si tiene datos
				if !isEmpty {
					results <- result{index: job.index, record: record}
				} else {
					// Devolver al pool si está vacío
					recordPool.Put(record)
				}
			}
		}()
	}

	// Enviar trabajos
	go func() {
		for i, row := range rows {
			jobs <- job{index: i, row: row}
		}
		close(jobs)
	}()

	// Esperar a que terminen los workers
	go func() {
		wg.Wait()
		close(results)
	}()

	// Recolectar resultados (mantener orden original)
	recordsMap := make(map[int]map[string]interface{})
	for res := range results {
		recordsMap[res.index] = res.record
	}

	// Convertir a slice ordenado
	records := make([]map[string]interface{}, 0, len(recordsMap))
	for i := 0; i < len(rows); i++ {
		if record, exists := recordsMap[i]; exists {
			records = append(records, record)
		}
	}

	return records
}

// insertRecordsOptimized inserta registros en paralelo para máxima velocidad
func insertRecordsOptimized(ctx context.Context, excelID, userID int, records []map[string]interface{}, filename string) {
	totalRecords := len(records)
	batchSize := 5000 // Batches optimizados
	
	var processed atomic.Int32
	
	notify := func(progress float64, proc int) {
		scaledProgress := 20 + (progress * 0.79)
		notifyProgress(excelID, userID, &ProcessStatus{
			ExcelID:   excelID,
			Filename:  filename,
			Status:    "inserting",
			Message:   fmt.Sprintf("Insertando: %d/%d (%.1f%%)", proc, totalRecords, scaledProgress),
			Progress:  scaledProgress,
			Total:     totalRecords,
			Processed: proc,
		})
	}

	// Para archivos grandes (>100k), usar inserción paralela
	useParallel := totalRecords > 100000
	
	if !useParallel {
		// Inserción secuencial para archivos pequeños
		insertRecordsSequential(ctx, excelID, userID, records, filename, &processed, notify)
	} else {
		// Inserción paralela para archivos grandes
		insertRecordsParallel(ctx, excelID, userID, records, filename, batchSize, &processed, notify)
	}
}

// insertRecordsSequential inserta registros de forma secuencial
func insertRecordsSequential(ctx context.Context, excelID, userID int, records []map[string]interface{}, 
	filename string, processed *atomic.Int32, notify func(float64, int)) {
	
	totalRecords := len(records)
	batchSize := 5000
	rowIndex := 0
	lastNotified := 0

	for i := 0; i < len(records); i += batchSize {
		end := i + batchSize
		if end > len(records) {
			end = len(records)
		}
		batch := records[i:end]

		// Preparar datos para COPY
		rows := make([][]interface{}, 0, len(batch))
		now := time.Now()
		
		for _, record := range batch {
			rowDataJSON, _ := json.Marshal(record)
			rows = append(rows, []interface{}{excelID, userID, rowIndex, string(rowDataJSON), now})
			rowIndex++
		}

		// Usar CopyFrom con retry
		maxRetries := 3
		var err error
		for retry := 0; retry < maxRetries; retry++ {
			_, err = dbPool.CopyFrom(
				ctx,
				pgx.Identifier{"dynamic_records"},
				[]string{"excel_id", "user_id", "rowIndex", "rowData", "createdAt"},
				pgx.CopyFromRows(rows),
			)
			
			if err == nil {
				break
			}
			
			if retry < maxRetries-1 {
				log.Printf("⚠️ Error insertando batch (intento %d/%d): %v", retry+1, maxRetries, err)
				time.Sleep(time.Duration(retry+1) * 100 * time.Millisecond)
			} else {
				log.Printf("❌ Error insertando batch: %v", err)
			}
		}

		proc := int(processed.Add(int32(len(batch))))
		progress := float64(proc) / float64(totalRecords) * 100

		// Notificar cada 5000 registros o al final
		if (proc - lastNotified >= 5000) || proc == totalRecords {
			log.Printf("📝 Excel %d: %d/%d registros (%.1f%%)", excelID, proc, totalRecords, progress)
			notify(progress, proc)
			lastNotified = proc
		}
	}
}

// insertRecordsParallel inserta registros en paralelo usando múltiples goroutines
func insertRecordsParallel(ctx context.Context, excelID, userID int, records []map[string]interface{}, 
	filename string, batchSize int, processed *atomic.Int32, notify func(float64, int)) {
	
	totalRecords := len(records)
	
	// Usar 4 workers para inserción paralela
	numWorkers := 4
	
	type batch struct {
		records []map[string]interface{}
		startIdx int
	}
	
	jobs := make(chan batch, numWorkers*2)
	var wg sync.WaitGroup
	var notifyMux sync.Mutex // Mutex para sincronizar notificaciones
	lastNotified := 0

	// Lanzar workers
	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			
			for job := range jobs {
				// Preparar datos para COPY
				rows := make([][]interface{}, 0, len(job.records))
				now := time.Now()
				
				for i, record := range job.records {
					rowDataJSON, _ := json.Marshal(record)
					rows = append(rows, []interface{}{excelID, userID, job.startIdx + i, string(rowDataJSON), now})
				}

				// Usar CopyFrom con retry
				maxRetries := 3
				var err error
				for retry := 0; retry < maxRetries; retry++ {
					_, err = dbPool.CopyFrom(
						ctx,
						pgx.Identifier{"dynamic_records"},
						[]string{"excel_id", "user_id", "rowIndex", "rowData", "createdAt"},
						pgx.CopyFromRows(rows),
					)
					
					if err == nil {
						break
					}
					
					if retry < maxRetries-1 {
						time.Sleep(time.Duration(retry+1) * 100 * time.Millisecond)
					}
				}

				if err != nil {
					log.Printf("❌ Worker %d error: %v", workerID, err)
				}

				// Actualizar progreso
				proc := int(processed.Add(int32(len(job.records))))
				progress := float64(proc) / float64(totalRecords) * 100

				// Notificar con sincronización para evitar notificaciones duplicadas
				notifyMux.Lock()
				shouldNotify := (proc - lastNotified >= 5000) || proc >= totalRecords
				if shouldNotify {
					lastNotified = proc
					notifyMux.Unlock()
					log.Printf("📝 Excel %d: %d/%d registros (%.1f%%)", excelID, proc, totalRecords, progress)
					notify(progress, proc)
				} else {
					notifyMux.Unlock()
				}
			}
		}(w)
	}

	// Enviar trabajos
	go func() {
		rowIndex := 0
		for i := 0; i < len(records); i += batchSize {
			end := i + batchSize
			if end > len(records) {
				end = len(records)
			}
			
			jobs <- batch{
				records: records[i:end],
				startIdx: rowIndex,
			}
			rowIndex += (end - i)
		}
		close(jobs)
	}()

	// Esperar a que terminen todos los workers
	wg.Wait()
	
	// Notificación final garantizada
	finalProc := int(processed.Load())
	if finalProc > lastNotified {
		progress := float64(finalProc) / float64(totalRecords) * 100
		log.Printf("📝 Excel %d: %d/%d registros (%.1f%%) - Final", excelID, finalProc, totalRecords, progress)
		notify(progress, finalProc)
	}
}

// ============================================================================
// ENDPOINTS
// ============================================================================

func getActiveProcessEndpoint(c *fiber.Ctx) error {
	userIDStr := c.Params("user_id")
	userID, err := strconv.Atoi(userIDStr)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "user_id inválido"})
	}

	status := getActiveProcess(userID)
	if status != nil {
		log.Printf("📊 Proceso activo para usuario %d: Excel %d - %s", userID, status.ExcelID, status.Status)
		return c.JSON(fiber.Map{
			"hasActiveProcess": true,
			"excelId":          status.ExcelID,
			"filename":         status.Filename,
			"progress":         status.Progress,
			"total":            status.Total,
			"processed":        status.Processed,
			"status":           status.Status,
			"message":          status.Message,
		})
	}

	return c.JSON(fiber.Map{"hasActiveProcess": false})
}

func healthCheck(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status":  "healthy",
		"service": "excel-processor-go",
		"time":    time.Now().Format(time.RFC3339),
	})
}

// ============================================================================
// MAIN
// ============================================================================

func main() {
	// Cargar variables de entorno
	envPath := "../.env"
	if _, err := os.Stat(envPath); err == nil {
		godotenv.Load(envPath)
		log.Printf("📋 Variables cargadas desde %s", envPath)
	} else {
		godotenv.Load()
	}

	// Configurar URL del backend
	backendURL = os.Getenv("BACKEND_URL")
	if backendURL == "" {
		backendURL = "http://localhost:3000"
	}
	log.Printf("🔗 Backend URL: %s", backendURL)

	// Conectar a PostgreSQL
	dbHost := os.Getenv("DB_HOST")
	if dbHost == "" {
		dbHost = "localhost"
	}
	dbPort := os.Getenv("DB_PORT")
	if dbPort == "" {
		dbPort = "5432"
	}
	dbUser := os.Getenv("DB_USER")
	if dbUser == "" {
		dbUser = "root"
	}
	dbPass := os.Getenv("DB_PASSWORD")
	if dbPass == "" {
		dbPass = "password"
	}
	dbName := os.Getenv("DB_NAME")
	if dbName == "" {
		dbName = "autochat_db"
	}

	connStr := fmt.Sprintf("postgres://%s:%s@%s:%s/%s", dbUser, dbPass, dbHost, dbPort, dbName)

	// Configurar pool optimizado para operaciones masivas
	poolConfig, err := pgxpool.ParseConfig(connStr)
	if err != nil {
		log.Fatalf("❌ Error parseando config: %v", err)
	}

	// Optimizaciones del pool
	poolConfig.MaxConns = 20                              // Más conexiones concurrentes
	poolConfig.MinConns = 5                               // Mantener conexiones listas
	poolConfig.MaxConnLifetime = time.Hour                // Reciclar conexiones cada hora
	poolConfig.MaxConnIdleTime = 30 * time.Minute        // Cerrar conexiones idle después de 30min
	poolConfig.HealthCheckPeriod = 1 * time.Minute       // Verificar salud del pool
	poolConfig.ConnConfig.ConnectTimeout = 10 * time.Second // Timeout de conexión

	// Crear pool con configuración optimizada
	dbPool, err = pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		log.Fatalf("❌ Error conectando a PostgreSQL: %v", err)
	}
	defer dbPool.Close()

	log.Printf("✅ Conectado a PostgreSQL (%s:%s/%s) - Pool: %d conns (min: %d)", 
		dbHost, dbPort, dbName, poolConfig.MaxConns, poolConfig.MinConns)

	// Configurar Fiber
	app := fiber.New(fiber.Config{
		BodyLimit: 500 * 1024 * 1024, // 500MB
	})

	app.Use(logger.New())
	app.Use(cors.New(cors.Config{
		AllowOrigins: "*",
		AllowMethods: "GET,POST,PUT,DELETE",
		AllowHeaders: "Origin, Content-Type, Accept, Authorization",
	}))

	// Rutas
	app.Get("/health", healthCheck)
	app.Post("/process", processExcel)
	app.Get("/active-process/:user_id", getActiveProcessEndpoint)

	// Iniciar servidor
	port := os.Getenv("EXCEL_PROCESSOR_PORT")
	if port == "" {
		port = "8001"
	}

	log.Printf("🚀 Excel Processor (Go) corriendo en http://localhost:%s", port)
	log.Fatal(app.Listen(":" + port))
}
